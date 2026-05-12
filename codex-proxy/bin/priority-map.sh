#!/usr/bin/env bash
set -euo pipefail

LIMIT="${1:-30000}"
API_JSON_LOG="${CODEX_PROXY_API_JSON_LOG_FILE:-/tmp/codex-proxy-api-json.ndjson}"
RAW_EVENT_LOG="${CODEX_PROXY_RAW_EVENT_LOG_FILE:-/tmp/codex-proxy-events.ndjson}"
HARMONY_LOG="${CODEX_PROXY_HARMONY_LOG_FILE:-/tmp/codex-proxy-harmony.ndjson}"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"

python3 - "$LIMIT" "$API_JSON_LOG" "$RAW_EVENT_LOG" "$HARMONY_LOG" "$CODEX_HOME" <<'PY'
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import sys
from collections import Counter, defaultdict, deque
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

limit = int(sys.argv[1])
api_json_log = Path(sys.argv[2])
raw_event_log = Path(sys.argv[3])
harmony_log = Path(sys.argv[4])
codex_home = Path(sys.argv[5]).expanduser()


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]


def safe_path(path: Path) -> str:
    home = Path.home()
    try:
        return "~/" + str(path.resolve().relative_to(home))
    except Exception:
        return str(path)


def read_tail_jsonl(path: Path, n: int) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: deque[dict[str, Any]] = deque(maxlen=n)
    with path.open("r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                value = json.loads(line)
            except Exception:
                continue
            if isinstance(value, dict):
                rows.append(value)
    return list(rows)


def short_value(value: Any) -> dict[str, Any]:
    if value is None:
        return {"present": False}
    if isinstance(value, str):
        return {"present": True, "kind": "string", "length": len(value), "hash": digest(value)}
    encoded = json.dumps(value, sort_keys=True, default=str)
    return {"present": True, "kind": type(value).__name__, "length": len(encoded), "hash": digest(encoded)}


def count_dict(counter: Counter) -> dict[str, int]:
    return dict(counter.most_common())


def parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except Exception:
        return None


def ms_between(start: Any, end: Any) -> int | None:
    a = parse_time(start)
    b = parse_time(end)
    if not a or not b:
        return None
    return max(0, int((b - a).total_seconds() * 1000))


def percentile(values: list[int], pct: float) -> int | None:
    if not values:
        return None
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * pct)))
    return ordered[idx]


def stats(values: list[int]) -> dict[str, Any]:
    if not values:
        return {"count": 0}
    return {
        "count": len(values),
        "min": min(values),
        "p50": percentile(values, 0.5),
        "p90": percentile(values, 0.9),
        "max": max(values),
        "avg": round(sum(values) / len(values), 1),
    }


def safe_shape(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, str):
        return short_value(value)
    if isinstance(value, (int, float, bool)):
        return value
    if isinstance(value, list):
        return {
            "kind": "list",
            "length": len(value),
            "hash": digest(json.dumps(value, sort_keys=True, default=str)),
        }
    if isinstance(value, dict):
        return {
            "kind": "object",
            "keys": sorted(value.keys()),
            "hash": digest(json.dumps(value, sort_keys=True, default=str)),
        }
    return {"kind": type(value).__name__, "reprHash": digest(repr(value))}


def metadata_shape(metadata: dict[str, Any]) -> dict[str, Any]:
    return {str(k): safe_shape(v) for k, v in sorted(metadata.items())}


def summarize_request_body(body: dict[str, Any]) -> dict[str, Any]:
    input_items = body.get("input") if isinstance(body.get("input"), list) else []
    input_types: Counter[str] = Counter()
    message_roles: Counter[str] = Counter()
    tool_names: Counter[str] = Counter()
    priority_items: list[dict[str, Any]] = []
    encrypted_reasoning = 0

    for index, item in enumerate(input_items):
        if not isinstance(item, dict):
            continue
        item_type = item.get("type") or item.get("role") or "unknown"
        input_types[str(item_type)] += 1
        if isinstance(item.get("role"), str):
            role = item["role"]
            message_roles[role] += 1
            if role in {"system", "developer"}:
                priority_items.append({
                    "index": index,
                    "role": role,
                    "content": short_value(item.get("content")),
                })
        if item_type in {"function_call", "custom_tool_call"} and isinstance(item.get("name"), str):
            tool_names[item["name"]] += 1
        if item_type == "reasoning" and isinstance(item.get("encrypted_content"), str):
            encrypted_reasoning += 1

    return {
        "model": body.get("model"),
        "stream": body.get("stream"),
        "bodyKeys": sorted(body.keys()),
        "instructions": short_value(body.get("instructions")),
        "reasoning": body.get("reasoning") if isinstance(body.get("reasoning"), dict) else None,
        "include": body.get("include") if isinstance(body.get("include"), list) else None,
        "promptCacheKey": short_value(body.get("prompt_cache_key")),
        "inputCount": len(input_items),
        "inputTypes": count_dict(input_types),
        "messageRoles": count_dict(message_roles),
        "toolNames": count_dict(tool_names),
        "priorityInputItems": priority_items[-12:],
        "encryptedReasoningInputItems": encrypted_reasoning,
    }


def summarize_api_log(rows: list[dict[str, Any]]) -> dict[str, Any]:
    request_rows = [
        row for row in rows
        if row.get("phase") == "request.forwarded"
        and row.get("path") == "/responses"
        and isinstance(row.get("body"), dict)
    ]
    phase_counts = Counter(str(row.get("phase", "unknown")) for row in rows)
    path_counts = Counter(str(row.get("path", "unknown")) for row in rows if row.get("path"))
    instruction_hashes: Counter[str] = Counter()
    reasoning_configs: Counter[str] = Counter()
    include_configs: Counter[str] = Counter()
    input_types_total: Counter[str] = Counter()
    message_roles_total: Counter[str] = Counter()

    latest = None
    for row in request_rows:
        body_summary = summarize_request_body(row["body"])
        latest = {
            "at": row.get("at"),
            "requestId": row.get("requestId"),
            "path": row.get("path"),
            "body": body_summary,
        }
        inst = body_summary["instructions"]
        if inst.get("present"):
            instruction_hashes[f"{inst.get('hash')}:{inst.get('length')}"] += 1
        reasoning_configs[json.dumps(body_summary.get("reasoning"), sort_keys=True)] += 1
        include_configs[json.dumps(body_summary.get("include"), sort_keys=True)] += 1
        input_types_total.update(body_summary["inputTypes"])
        message_roles_total.update(body_summary["messageRoles"])

    return {
        "recordsRead": len(rows),
        "phaseCounts": count_dict(phase_counts),
        "pathCounts": count_dict(path_counts),
        "responseCreateRequests": len(request_rows),
        "instructionHashLengths": count_dict(instruction_hashes),
        "reasoningConfigs": count_dict(reasoning_configs),
        "includeConfigs": count_dict(include_configs),
        "inputTypes": count_dict(input_types_total),
        "messageRoles": count_dict(message_roles_total),
        "latestResponseCreate": latest,
    }


def event_layer(event_type: str, event: dict[str, Any]) -> str:
    if "reasoning_summary" in event_type or "reasoning_text" in event_type:
        return "analysis.visible"
    if "output_text" in event_type or "content_part" in event_type:
        return "commentary.visible"
    if "function_call" in event_type or "custom_tool" in event_type:
        return "tool.routing"
    item = event.get("item") if isinstance(event.get("item"), dict) else {}
    if item.get("type") == "reasoning":
        return "state.encrypted_reasoning" if isinstance(item.get("encrypted_content"), str) else "analysis.item"
    if event_type.startswith("response."):
        return "response.lifecycle"
    return "other"


def summarize_raw_events(rows: list[dict[str, Any]]) -> dict[str, Any]:
    types: Counter[str] = Counter()
    layers: Counter[str] = Counter()
    prompt_cache_keys: Counter[str] = Counter()
    encrypted_reasoning: Counter[str] = Counter()

    for row in rows:
        event = row.get("event") if isinstance(row.get("event"), dict) else {}
        event_type = str(row.get("type") or event.get("type") or "unknown")
        types[event_type] += 1
        layers[event_layer(event_type, event)] += 1
        response = event.get("response") if isinstance(event.get("response"), dict) else {}
        if isinstance(response.get("prompt_cache_key"), str):
            prompt_cache_keys[f"{digest(response['prompt_cache_key'])}:{len(response['prompt_cache_key'])}"] += 1
        item = event.get("item") if isinstance(event.get("item"), dict) else {}
        if item.get("type") == "reasoning" and isinstance(item.get("encrypted_content"), str):
            encrypted_reasoning[f"{digest(item['encrypted_content'])}:{len(item['encrypted_content'])}"] += 1

    return {
        "recordsRead": len(rows),
        "layers": count_dict(layers),
        "topEventTypes": dict(types.most_common(30)),
        "promptCacheKeyHashLengths": count_dict(prompt_cache_keys),
        "encryptedReasoningHashLengths": count_dict(encrypted_reasoning),
    }


def summarize_harmony(rows: list[dict[str, Any]]) -> dict[str, Any]:
    phases: Counter[str] = Counter()
    channels: Counter[str] = Counter()
    tiers: dict[str, dict[str, int]] = defaultdict(lambda: {"messages": 0, "bytes": 0})
    tier_hashes: defaultdict[str, Counter[str]] = defaultdict(Counter)
    permissions: list[dict[str, Any]] = []
    injections_by_rule: Counter[str] = Counter()
    injections_by_severity: Counter[str] = Counter()
    injections_by_tier: Counter[str] = Counter()
    profiles: Counter[str] = Counter()
    profile_events: Counter[str] = Counter()
    metadata_keys: Counter[str] = Counter()
    metadata_samples: dict[str, Any] = {}
    tool_names: Counter[str] = Counter()
    tool_types: Counter[str] = Counter()
    completed_by_request: dict[str, dict[str, Any]] = {}
    started_by_request: dict[str, str] = {}
    first_chunk_by_request: dict[str, str] = {}
    request_ids: set[str] = set()
    sessions: Counter[str] = Counter()
    latest_tier_summary: dict[str, Any] | None = None
    latest_completed: dict[str, Any] | None = None
    latest_metadata: dict[str, Any] | None = None

    for row in rows:
        phase = str(row.get("phase", "unknown"))
        phases[phase] += 1
        request_id = row.get("requestId")
        if isinstance(request_id, str):
            request_ids.add(request_id)
        session_id = row.get("sessionId")
        if isinstance(session_id, str):
            sessions[session_id] += 1

        if phase == "request.input_item":
            tier = str(row.get("tier") or "unknown")
            tiers[tier]["messages"] += 1
            tiers[tier]["bytes"] += int(row.get("byteLen") or 0)
            if isinstance(row.get("contentHash"), str):
                tier_hashes[tier][f"{row['contentHash']}:{row.get('byteLen') or 0}"] += 1
            if isinstance(request_id, str) and request_id not in started_by_request:
                started_by_request[request_id] = str(row.get("at") or "")

        if phase == "request.permissions_claim":
            permissions.append({
                "at": row.get("at"),
                "requestId": row.get("requestId"),
                "sessionId": row.get("sessionId"),
                "index": row.get("index"),
                "tier": row.get("tier"),
                "sandboxMode": row.get("sandboxMode"),
                "networkAccess": row.get("networkAccess"),
                "approvalPolicy": row.get("approvalPolicy"),
                "rawHash": row.get("rawHash"),
            })

        if phase == "request.injection_detected":
            injections_by_rule[str(row.get("rule", "unknown"))] += 1
            injections_by_severity[str(row.get("severity", "unknown"))] += 1
            injections_by_tier[str(row.get("tier", "unknown"))] += 1

        if phase.startswith("request.profile_") or phase == "response.profile_channel_dropped":
            profile = str(row.get("profile") or "unknown")
            profiles[profile] += 1
            profile_events[phase] += 1

        if phase == "request.tier_summary":
            latest_tier_summary = row
            for ty, count in (row.get("toolByType") or {}).items():
                tool_types[str(ty)] += int(count or 0)

        if phase in {"response.channel_chunk", "response.tool_call.delta", "response.tool_call.done"}:
            channel = str(row.get("channel") or "unknown")
            channels[channel] += 1
            if isinstance(request_id, str) and request_id not in first_chunk_by_request:
                first_chunk_by_request[request_id] = str(row.get("at") or "")
            if isinstance(row.get("name"), str):
                tool_names[row["name"]] += 1
            if isinstance(row.get("toolType"), str):
                tool_types[row["toolType"]] += 1

        if phase == "response.metadata_observed":
            latest_metadata = row
            metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
            for key, value in metadata.items():
                metadata_keys[str(key)] += 1
                metadata_samples[str(key)] = safe_shape(value)

        if phase == "response.completed":
            latest_completed = row
            if isinstance(request_id, str):
                completed_by_request[request_id] = row
            metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
            for key, value in metadata.items():
                metadata_keys[str(key)] += 1
                metadata_samples[str(key)] = safe_shape(value)

    durations: list[int] = []
    first_chunk_latencies: list[int] = []
    token_rates: list[int] = []
    completed_rows = list(completed_by_request.values())
    for rid, complete in completed_by_request.items():
        duration = ms_between(started_by_request.get(rid), complete.get("at"))
        if duration is not None:
            durations.append(duration)
            output = complete.get("outputTokens")
            if isinstance(output, int) and duration > 0:
                token_rates.append(round(output / (duration / 1000)))
        first = ms_between(started_by_request.get(rid), first_chunk_by_request.get(rid))
        if first is not None:
            first_chunk_latencies.append(first)

    return {
        "recordsRead": len(rows),
        "requestIds": len(request_ids),
        "sessions": count_dict(sessions),
        "phases": count_dict(phases),
        "channels": count_dict(channels),
        "tiers": dict(sorted(tiers.items())),
        "topTierHashes": {
            tier: dict(counter.most_common(12))
            for tier, counter in sorted(tier_hashes.items())
        },
        "permissions": {
            "count": len(permissions),
            "latest": permissions[-5:],
        },
        "injections": {
            "byRule": count_dict(injections_by_rule),
            "bySeverity": count_dict(injections_by_severity),
            "byTier": count_dict(injections_by_tier),
        },
        "profiles": {
            "byName": count_dict(profiles),
            "events": count_dict(profile_events),
        },
        "tools": {
            "names": count_dict(tool_names),
            "types": count_dict(tool_types),
            "latestCatalog": {
                "toolCount": latest_tier_summary.get("toolCount") if latest_tier_summary else None,
                "toolByType": latest_tier_summary.get("toolByType") if latest_tier_summary else None,
            },
        },
        "reasoning": {
            "latestEffort": latest_tier_summary.get("reasoningEffort") if latest_tier_summary else None,
            "latestSummary": latest_tier_summary.get("reasoningSummary") if latest_tier_summary else None,
            "latestPromptCacheKey": short_value(latest_tier_summary.get("promptCacheKey")) if latest_tier_summary else {"present": False},
        },
        "metadata": {
            "keys": count_dict(metadata_keys),
            "samples": metadata_samples,
            "latestAt": latest_metadata.get("at") if latest_metadata else None,
        },
        "tokens": {
            "completedResponses": len(completed_rows),
            "input": stats([int(r["inputTokens"]) for r in completed_rows if isinstance(r.get("inputTokens"), int)]),
            "output": stats([int(r["outputTokens"]) for r in completed_rows if isinstance(r.get("outputTokens"), int)]),
            "outputTokensPerSecond": stats(token_rates),
        },
        "timingMs": {
            "requestToComplete": stats(durations),
            "requestToFirstChunk": stats(first_chunk_latencies),
        },
        "responseShape": {
            "latest": {
                "requestId": latest_completed.get("requestId") if latest_completed else None,
                "model": latest_completed.get("model") if latest_completed else None,
                "stopReason": latest_completed.get("stopReason") if latest_completed else None,
                "finalLen": latest_completed.get("finalLen") if latest_completed else None,
                "analysisLen": latest_completed.get("analysisLen") if latest_completed else None,
                "fnCalls": latest_completed.get("fnCalls") if latest_completed else None,
                "customCalls": latest_completed.get("customCalls") if latest_completed else None,
                "encryptedReasoningCount": latest_completed.get("encryptedReasoningCount") if latest_completed else None,
                "encryptedReasoningTotalBytes": latest_completed.get("encryptedReasoningTotalBytes") if latest_completed else None,
                "metadata": metadata_shape(latest_completed.get("metadata") or {}) if latest_completed else None,
            }
        },
        "coverage": {
            "hasTierSummary": phases["request.tier_summary"] > 0,
            "hasPermissions": phases["request.permissions_claim"] > 0,
            "hasInjections": phases["request.injection_detected"] > 0,
            "hasMetadata": phases["response.metadata_observed"] > 0,
            "hasChannelChunks": phases["response.channel_chunk"] > 0,
            "hasToolCalls": phases["response.tool_call.done"] > 0 or phases["response.tool_call.delta"] > 0,
            "hasCompletions": phases["response.completed"] > 0,
            "hasProfiles": bool(profiles),
        },
    }


def newest_session_file() -> Path | None:
    root = codex_home / "sessions"
    if not root.exists():
        return None
    files = [p for p in root.rglob("rollout-*.jsonl") if p.is_file()]
    if not files:
        return None
    return max(files, key=lambda p: p.stat().st_mtime)


def summarize_session_file(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {"available": False}
    record_types: Counter[str] = Counter()
    payload_types: Counter[str] = Counter()
    priority_surfaces: defaultdict[str, Counter[str]] = defaultdict(Counter)
    tool_names: Counter[str] = Counter()
    encrypted_reasoning: Counter[str] = Counter()
    parsed = 0

    with path.open("r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except Exception:
                continue
            parsed += 1
            record_type = str(row.get("type", "unknown"))
            record_types[record_type] += 1
            payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
            payload_type = payload.get("type")
            if isinstance(payload_type, str):
                payload_types[payload_type] += 1

            if record_type == "session_meta":
                for key in ["base_instructions", "dynamic_tools", "model_provider", "source"]:
                    if key in payload:
                        value = short_value(payload.get(key))
                        priority_surfaces[f"session_meta.{key}"][f"{value.get('hash')}:{value.get('length')}"] += 1

            if record_type == "turn_context":
                for key in ["developer_instructions", "user_instructions", "summary", "personality", "model", "effort"]:
                    if key in payload:
                        value = short_value(payload.get(key))
                        priority_surfaces[f"turn_context.{key}"][f"{value.get('hash')}:{value.get('length')}"] += 1

            if payload_type in {"function_call", "custom_tool_call"} and isinstance(payload.get("name"), str):
                tool_names[payload["name"]] += 1

            if payload_type == "reasoning" and isinstance(payload.get("encrypted_content"), str):
                encrypted_reasoning[f"{digest(payload['encrypted_content'])}:{len(payload['encrypted_content'])}"] += 1

    return {
        "available": True,
        "path": safe_path(path),
        "bytes": path.stat().st_size,
        "parsedLines": parsed,
        "recordTypes": count_dict(record_types),
        "payloadTypes": count_dict(payload_types),
        "prioritySurfaces": {key: count_dict(counter) for key, counter in priority_surfaces.items()},
        "toolNames": count_dict(tool_names),
        "encryptedReasoningHashLengths": count_dict(encrypted_reasoning),
    }


def sqlite_counts() -> dict[str, Any]:
    out: dict[str, Any] = {}
    for label, db in {"state": codex_home / "state_5.sqlite", "logs": codex_home / "logs_2.sqlite"}.items():
        if not db.exists():
            out[label] = {"available": False}
            continue
        conn = sqlite3.connect(str(db))
        try:
            tables = [row[0] for row in conn.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'")]
            counts = {}
            for table in tables:
                try:
                    counts[table] = conn.execute(f'select count(*) from "{table.replace(chr(34), chr(34)*2)}"').fetchone()[0]
                except Exception:
                    counts[table] = None
            out[label] = {"available": True, "path": safe_path(db), "tables": counts}
        finally:
            conn.close()
    return out


api_rows = read_tail_jsonl(api_json_log, limit)
raw_rows = read_tail_jsonl(raw_event_log, limit)
harmony_rows = read_tail_jsonl(harmony_log, limit)
session_path = newest_session_file()

print(json.dumps({
    "run": {
        "at": datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "limit": limit,
        "apiJsonLog": str(api_json_log),
        "rawEventLog": str(raw_event_log),
        "harmonyLog": str(harmony_log),
        "codexHome": safe_path(codex_home),
        "mode": "shell observability map",
        "note": "No raw instruction, auth, or message content is printed. Values are summarized as counts, lengths, and SHA-256 prefixes.",
    },
    "priorityOrderObserved": [
        "local config/default instructions -> request.instructions",
        "session_meta.base_instructions -> local session JSONL",
        "turn_context.developer_instructions -> local session JSONL",
        "turn_context.user_instructions -> local session JSONL",
        "request.input[] role=system/developer if present",
        "backend SSE visible summary/text/tool/state events",
    ],
    "api": summarize_api_log(api_rows),
    "events": summarize_raw_events(raw_rows),
    "harmony": summarize_harmony(harmony_rows),
    "session": summarize_session_file(session_path),
    "sqlite": sqlite_counts(),
}, indent=2, sort_keys=True))
PY
