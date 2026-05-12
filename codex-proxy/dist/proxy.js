// @bun
// src/server.ts
import { appendFileSync, existsSync, readFileSync as readFileSync3 } from "fs";

// node_modules/hono/dist/compose.js
var compose = (middleware, onError, onNotFound) => {
  return (context, next) => {
    let index = -1;
    return dispatch(0);
    async function dispatch(i) {
      if (i <= index) {
        throw new Error("next() called multiple times");
      }
      index = i;
      let res;
      let isError = false;
      let handler;
      if (middleware[i]) {
        handler = middleware[i][0][0];
        context.req.routeIndex = i;
      } else {
        handler = i === middleware.length && next || undefined;
      }
      if (handler) {
        try {
          res = await handler(context, () => dispatch(i + 1));
        } catch (err) {
          if (err instanceof Error && onError) {
            context.error = err;
            res = await onError(err, context);
            isError = true;
          } else {
            throw err;
          }
        }
      } else {
        if (context.finalized === false && onNotFound) {
          res = await onNotFound(context);
        }
      }
      if (res && (context.finalized === false || isError)) {
        context.res = res;
      }
      return context;
    }
  };
};

// node_modules/hono/dist/request/constants.js
var GET_MATCH_RESULT = /* @__PURE__ */ Symbol();

// node_modules/hono/dist/utils/body.js
var parseBody = async (request, options = /* @__PURE__ */ Object.create(null)) => {
  const { all = false, dot = false } = options;
  const headers = request instanceof HonoRequest ? request.raw.headers : request.headers;
  const contentType = headers.get("Content-Type");
  if (contentType?.startsWith("multipart/form-data") || contentType?.startsWith("application/x-www-form-urlencoded")) {
    return parseFormData(request, { all, dot });
  }
  return {};
};
async function parseFormData(request, options) {
  const formData = await request.formData();
  if (formData) {
    return convertFormDataToBodyData(formData, options);
  }
  return {};
}
function convertFormDataToBodyData(formData, options) {
  const form = /* @__PURE__ */ Object.create(null);
  formData.forEach((value, key) => {
    const shouldParseAllValues = options.all || key.endsWith("[]");
    if (!shouldParseAllValues) {
      form[key] = value;
    } else {
      handleParsingAllValues(form, key, value);
    }
  });
  if (options.dot) {
    Object.entries(form).forEach(([key, value]) => {
      const shouldParseDotValues = key.includes(".");
      if (shouldParseDotValues) {
        handleParsingNestedValues(form, key, value);
        delete form[key];
      }
    });
  }
  return form;
}
var handleParsingAllValues = (form, key, value) => {
  if (form[key] !== undefined) {
    if (Array.isArray(form[key])) {
      form[key].push(value);
    } else {
      form[key] = [form[key], value];
    }
  } else {
    if (!key.endsWith("[]")) {
      form[key] = value;
    } else {
      form[key] = [value];
    }
  }
};
var handleParsingNestedValues = (form, key, value) => {
  if (/(?:^|\.)__proto__\./.test(key)) {
    return;
  }
  let nestedForm = form;
  const keys = key.split(".");
  keys.forEach((key2, index) => {
    if (index === keys.length - 1) {
      nestedForm[key2] = value;
    } else {
      if (!nestedForm[key2] || typeof nestedForm[key2] !== "object" || Array.isArray(nestedForm[key2]) || nestedForm[key2] instanceof File) {
        nestedForm[key2] = /* @__PURE__ */ Object.create(null);
      }
      nestedForm = nestedForm[key2];
    }
  });
};

// node_modules/hono/dist/utils/url.js
var splitPath = (path) => {
  const paths = path.split("/");
  if (paths[0] === "") {
    paths.shift();
  }
  return paths;
};
var splitRoutingPath = (routePath) => {
  const { groups, path } = extractGroupsFromPath(routePath);
  const paths = splitPath(path);
  return replaceGroupMarks(paths, groups);
};
var extractGroupsFromPath = (path) => {
  const groups = [];
  path = path.replace(/\{[^}]+\}/g, (match, index) => {
    const mark = `@${index}`;
    groups.push([mark, match]);
    return mark;
  });
  return { groups, path };
};
var replaceGroupMarks = (paths, groups) => {
  for (let i = groups.length - 1;i >= 0; i--) {
    const [mark] = groups[i];
    for (let j = paths.length - 1;j >= 0; j--) {
      if (paths[j].includes(mark)) {
        paths[j] = paths[j].replace(mark, groups[i][1]);
        break;
      }
    }
  }
  return paths;
};
var patternCache = {};
var getPattern = (label, next) => {
  if (label === "*") {
    return "*";
  }
  const match = label.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
  if (match) {
    const cacheKey = `${label}#${next}`;
    if (!patternCache[cacheKey]) {
      if (match[2]) {
        patternCache[cacheKey] = next && next[0] !== ":" && next[0] !== "*" ? [cacheKey, match[1], new RegExp(`^${match[2]}(?=/${next})`)] : [label, match[1], new RegExp(`^${match[2]}$`)];
      } else {
        patternCache[cacheKey] = [label, match[1], true];
      }
    }
    return patternCache[cacheKey];
  }
  return null;
};
var tryDecode = (str, decoder) => {
  try {
    return decoder(str);
  } catch {
    return str.replace(/(?:%[0-9A-Fa-f]{2})+/g, (match) => {
      try {
        return decoder(match);
      } catch {
        return match;
      }
    });
  }
};
var tryDecodeURI = (str) => tryDecode(str, decodeURI);
var getPath = (request) => {
  const url = request.url;
  const start = url.indexOf("/", url.indexOf(":") + 4);
  let i = start;
  for (;i < url.length; i++) {
    const charCode = url.charCodeAt(i);
    if (charCode === 37) {
      const queryIndex = url.indexOf("?", i);
      const hashIndex = url.indexOf("#", i);
      const end = queryIndex === -1 ? hashIndex === -1 ? undefined : hashIndex : hashIndex === -1 ? queryIndex : Math.min(queryIndex, hashIndex);
      const path = url.slice(start, end);
      return tryDecodeURI(path.includes("%25") ? path.replace(/%25/g, "%2525") : path);
    } else if (charCode === 63 || charCode === 35) {
      break;
    }
  }
  return url.slice(start, i);
};
var getPathNoStrict = (request) => {
  const result = getPath(request);
  return result.length > 1 && result.at(-1) === "/" ? result.slice(0, -1) : result;
};
var mergePath = (base, sub, ...rest) => {
  if (rest.length) {
    sub = mergePath(sub, ...rest);
  }
  return `${base?.[0] === "/" ? "" : "/"}${base}${sub === "/" ? "" : `${base?.at(-1) === "/" ? "" : "/"}${sub?.[0] === "/" ? sub.slice(1) : sub}`}`;
};
var checkOptionalParameter = (path) => {
  if (path.charCodeAt(path.length - 1) !== 63 || !path.includes(":")) {
    return null;
  }
  const segments = path.split("/");
  const results = [];
  let basePath = "";
  segments.forEach((segment) => {
    if (segment !== "" && !/\:/.test(segment)) {
      basePath += "/" + segment;
    } else if (/\:/.test(segment)) {
      if (/\?/.test(segment)) {
        if (results.length === 0 && basePath === "") {
          results.push("/");
        } else {
          results.push(basePath);
        }
        const optionalSegment = segment.replace("?", "");
        basePath += "/" + optionalSegment;
        results.push(basePath);
      } else {
        basePath += "/" + segment;
      }
    }
  });
  return results.filter((v, i, a) => a.indexOf(v) === i);
};
var _decodeURI = (value) => {
  if (!/[%+]/.test(value)) {
    return value;
  }
  if (value.indexOf("+") !== -1) {
    value = value.replace(/\+/g, " ");
  }
  return value.indexOf("%") !== -1 ? tryDecode(value, decodeURIComponent_) : value;
};
var _getQueryParam = (url, key, multiple) => {
  let encoded;
  if (!multiple && key && !/[%+]/.test(key)) {
    let keyIndex2 = url.indexOf("?", 8);
    if (keyIndex2 === -1) {
      return;
    }
    if (!url.startsWith(key, keyIndex2 + 1)) {
      keyIndex2 = url.indexOf(`&${key}`, keyIndex2 + 1);
    }
    while (keyIndex2 !== -1) {
      const trailingKeyCode = url.charCodeAt(keyIndex2 + key.length + 1);
      if (trailingKeyCode === 61) {
        const valueIndex = keyIndex2 + key.length + 2;
        const endIndex = url.indexOf("&", valueIndex);
        return _decodeURI(url.slice(valueIndex, endIndex === -1 ? undefined : endIndex));
      } else if (trailingKeyCode == 38 || isNaN(trailingKeyCode)) {
        return "";
      }
      keyIndex2 = url.indexOf(`&${key}`, keyIndex2 + 1);
    }
    encoded = /[%+]/.test(url);
    if (!encoded) {
      return;
    }
  }
  const results = {};
  encoded ??= /[%+]/.test(url);
  let keyIndex = url.indexOf("?", 8);
  while (keyIndex !== -1) {
    const nextKeyIndex = url.indexOf("&", keyIndex + 1);
    let valueIndex = url.indexOf("=", keyIndex);
    if (valueIndex > nextKeyIndex && nextKeyIndex !== -1) {
      valueIndex = -1;
    }
    let name = url.slice(keyIndex + 1, valueIndex === -1 ? nextKeyIndex === -1 ? undefined : nextKeyIndex : valueIndex);
    if (encoded) {
      name = _decodeURI(name);
    }
    keyIndex = nextKeyIndex;
    if (name === "") {
      continue;
    }
    let value;
    if (valueIndex === -1) {
      value = "";
    } else {
      value = url.slice(valueIndex + 1, nextKeyIndex === -1 ? undefined : nextKeyIndex);
      if (encoded) {
        value = _decodeURI(value);
      }
    }
    if (multiple) {
      if (!(results[name] && Array.isArray(results[name]))) {
        results[name] = [];
      }
      results[name].push(value);
    } else {
      results[name] ??= value;
    }
  }
  return key ? results[key] : results;
};
var getQueryParam = _getQueryParam;
var getQueryParams = (url, key) => {
  return _getQueryParam(url, key, true);
};
var decodeURIComponent_ = decodeURIComponent;

// node_modules/hono/dist/request.js
var tryDecodeURIComponent = (str) => tryDecode(str, decodeURIComponent_);
var HonoRequest = class {
  raw;
  #validatedData;
  #matchResult;
  routeIndex = 0;
  path;
  bodyCache = {};
  constructor(request, path = "/", matchResult = [[]]) {
    this.raw = request;
    this.path = path;
    this.#matchResult = matchResult;
    this.#validatedData = {};
  }
  param(key) {
    return key ? this.#getDecodedParam(key) : this.#getAllDecodedParams();
  }
  #getDecodedParam(key) {
    const paramKey = this.#matchResult[0][this.routeIndex][1][key];
    const param = this.#getParamValue(paramKey);
    return param && /\%/.test(param) ? tryDecodeURIComponent(param) : param;
  }
  #getAllDecodedParams() {
    const decoded = {};
    const keys = Object.keys(this.#matchResult[0][this.routeIndex][1]);
    for (const key of keys) {
      const value = this.#getParamValue(this.#matchResult[0][this.routeIndex][1][key]);
      if (value !== undefined) {
        decoded[key] = /\%/.test(value) ? tryDecodeURIComponent(value) : value;
      }
    }
    return decoded;
  }
  #getParamValue(paramKey) {
    return this.#matchResult[1] ? this.#matchResult[1][paramKey] : paramKey;
  }
  query(key) {
    return getQueryParam(this.url, key);
  }
  queries(key) {
    return getQueryParams(this.url, key);
  }
  header(name) {
    if (name) {
      return this.raw.headers.get(name) ?? undefined;
    }
    const headerData = {};
    this.raw.headers.forEach((value, key) => {
      headerData[key] = value;
    });
    return headerData;
  }
  async parseBody(options) {
    return this.bodyCache.parsedBody ??= await parseBody(this, options);
  }
  #cachedBody = (key) => {
    const { bodyCache, raw } = this;
    const cachedBody = bodyCache[key];
    if (cachedBody) {
      return cachedBody;
    }
    const anyCachedKey = Object.keys(bodyCache)[0];
    if (anyCachedKey) {
      return bodyCache[anyCachedKey].then((body) => {
        if (anyCachedKey === "json") {
          body = JSON.stringify(body);
        }
        return new Response(body)[key]();
      });
    }
    return bodyCache[key] = raw[key]();
  };
  json() {
    return this.#cachedBody("text").then((text) => JSON.parse(text));
  }
  text() {
    return this.#cachedBody("text");
  }
  arrayBuffer() {
    return this.#cachedBody("arrayBuffer");
  }
  blob() {
    return this.#cachedBody("blob");
  }
  formData() {
    return this.#cachedBody("formData");
  }
  addValidatedData(target, data) {
    this.#validatedData[target] = data;
  }
  valid(target) {
    return this.#validatedData[target];
  }
  get url() {
    return this.raw.url;
  }
  get method() {
    return this.raw.method;
  }
  get [GET_MATCH_RESULT]() {
    return this.#matchResult;
  }
  get matchedRoutes() {
    return this.#matchResult[0].map(([[, route]]) => route);
  }
  get routePath() {
    return this.#matchResult[0].map(([[, route]]) => route)[this.routeIndex].path;
  }
};

// node_modules/hono/dist/utils/html.js
var HtmlEscapedCallbackPhase = {
  Stringify: 1,
  BeforeStream: 2,
  Stream: 3
};
var raw = (value, callbacks) => {
  const escapedString = new String(value);
  escapedString.isEscaped = true;
  escapedString.callbacks = callbacks;
  return escapedString;
};
var resolveCallback = async (str, phase, preserveCallbacks, context, buffer) => {
  if (typeof str === "object" && !(str instanceof String)) {
    if (!(str instanceof Promise)) {
      str = str.toString();
    }
    if (str instanceof Promise) {
      str = await str;
    }
  }
  const callbacks = str.callbacks;
  if (!callbacks?.length) {
    return Promise.resolve(str);
  }
  if (buffer) {
    buffer[0] += str;
  } else {
    buffer = [str];
  }
  const resStr = Promise.all(callbacks.map((c) => c({ phase, buffer, context }))).then((res) => Promise.all(res.filter(Boolean).map((str2) => resolveCallback(str2, phase, false, context, buffer))).then(() => buffer[0]));
  if (preserveCallbacks) {
    return raw(await resStr, callbacks);
  } else {
    return resStr;
  }
};

// node_modules/hono/dist/context.js
var TEXT_PLAIN = "text/plain; charset=UTF-8";
var setDefaultContentType = (contentType, headers) => {
  return {
    "Content-Type": contentType,
    ...headers
  };
};
var createResponseInstance = (body, init) => new Response(body, init);
var Context = class {
  #rawRequest;
  #req;
  env = {};
  #var;
  finalized = false;
  error;
  #status;
  #executionCtx;
  #res;
  #layout;
  #renderer;
  #notFoundHandler;
  #preparedHeaders;
  #matchResult;
  #path;
  constructor(req, options) {
    this.#rawRequest = req;
    if (options) {
      this.#executionCtx = options.executionCtx;
      this.env = options.env;
      this.#notFoundHandler = options.notFoundHandler;
      this.#path = options.path;
      this.#matchResult = options.matchResult;
    }
  }
  get req() {
    this.#req ??= new HonoRequest(this.#rawRequest, this.#path, this.#matchResult);
    return this.#req;
  }
  get event() {
    if (this.#executionCtx && "respondWith" in this.#executionCtx) {
      return this.#executionCtx;
    } else {
      throw Error("This context has no FetchEvent");
    }
  }
  get executionCtx() {
    if (this.#executionCtx) {
      return this.#executionCtx;
    } else {
      throw Error("This context has no ExecutionContext");
    }
  }
  get res() {
    return this.#res ||= createResponseInstance(null, {
      headers: this.#preparedHeaders ??= new Headers
    });
  }
  set res(_res) {
    if (this.#res && _res) {
      _res = createResponseInstance(_res.body, _res);
      for (const [k, v] of this.#res.headers.entries()) {
        if (k === "content-type") {
          continue;
        }
        if (k === "set-cookie") {
          const cookies = this.#res.headers.getSetCookie();
          _res.headers.delete("set-cookie");
          for (const cookie of cookies) {
            _res.headers.append("set-cookie", cookie);
          }
        } else {
          _res.headers.set(k, v);
        }
      }
    }
    this.#res = _res;
    this.finalized = true;
  }
  render = (...args) => {
    this.#renderer ??= (content) => this.html(content);
    return this.#renderer(...args);
  };
  setLayout = (layout) => this.#layout = layout;
  getLayout = () => this.#layout;
  setRenderer = (renderer) => {
    this.#renderer = renderer;
  };
  header = (name, value, options) => {
    if (this.finalized) {
      this.#res = createResponseInstance(this.#res.body, this.#res);
    }
    const headers = this.#res ? this.#res.headers : this.#preparedHeaders ??= new Headers;
    if (value === undefined) {
      headers.delete(name);
    } else if (options?.append) {
      headers.append(name, value);
    } else {
      headers.set(name, value);
    }
  };
  status = (status) => {
    this.#status = status;
  };
  set = (key, value) => {
    this.#var ??= /* @__PURE__ */ new Map;
    this.#var.set(key, value);
  };
  get = (key) => {
    return this.#var ? this.#var.get(key) : undefined;
  };
  get var() {
    if (!this.#var) {
      return {};
    }
    return Object.fromEntries(this.#var);
  }
  #newResponse(data, arg, headers) {
    const responseHeaders = this.#res ? new Headers(this.#res.headers) : this.#preparedHeaders ?? new Headers;
    if (typeof arg === "object" && "headers" in arg) {
      const argHeaders = arg.headers instanceof Headers ? arg.headers : new Headers(arg.headers);
      for (const [key, value] of argHeaders) {
        if (key.toLowerCase() === "set-cookie") {
          responseHeaders.append(key, value);
        } else {
          responseHeaders.set(key, value);
        }
      }
    }
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        if (typeof v === "string") {
          responseHeaders.set(k, v);
        } else {
          responseHeaders.delete(k);
          for (const v2 of v) {
            responseHeaders.append(k, v2);
          }
        }
      }
    }
    const status = typeof arg === "number" ? arg : arg?.status ?? this.#status;
    return createResponseInstance(data, { status, headers: responseHeaders });
  }
  newResponse = (...args) => this.#newResponse(...args);
  body = (data, arg, headers) => this.#newResponse(data, arg, headers);
  text = (text, arg, headers) => {
    return !this.#preparedHeaders && !this.#status && !arg && !headers && !this.finalized ? new Response(text) : this.#newResponse(text, arg, setDefaultContentType(TEXT_PLAIN, headers));
  };
  json = (object, arg, headers) => {
    return this.#newResponse(JSON.stringify(object), arg, setDefaultContentType("application/json", headers));
  };
  html = (html, arg, headers) => {
    const res = (html2) => this.#newResponse(html2, arg, setDefaultContentType("text/html; charset=UTF-8", headers));
    return typeof html === "object" ? resolveCallback(html, HtmlEscapedCallbackPhase.Stringify, false, {}).then(res) : res(html);
  };
  redirect = (location, status) => {
    const locationString = String(location);
    this.header("Location", !/[^\x00-\xFF]/.test(locationString) ? locationString : encodeURI(locationString));
    return this.newResponse(null, status ?? 302);
  };
  notFound = () => {
    this.#notFoundHandler ??= () => createResponseInstance();
    return this.#notFoundHandler(this);
  };
};

// node_modules/hono/dist/router.js
var METHOD_NAME_ALL = "ALL";
var METHOD_NAME_ALL_LOWERCASE = "all";
var METHODS = ["get", "post", "put", "delete", "options", "patch"];
var MESSAGE_MATCHER_IS_ALREADY_BUILT = "Can not add a route since the matcher is already built.";
var UnsupportedPathError = class extends Error {
};

// node_modules/hono/dist/utils/constants.js
var COMPOSED_HANDLER = "__COMPOSED_HANDLER";

// node_modules/hono/dist/hono-base.js
var notFoundHandler = (c) => {
  return c.text("404 Not Found", 404);
};
var errorHandler = (err, c) => {
  if ("getResponse" in err) {
    const res = err.getResponse();
    return c.newResponse(res.body, res);
  }
  console.error(err);
  return c.text("Internal Server Error", 500);
};
var Hono = class _Hono {
  get;
  post;
  put;
  delete;
  options;
  patch;
  all;
  on;
  use;
  router;
  getPath;
  _basePath = "/";
  #path = "/";
  routes = [];
  constructor(options = {}) {
    const allMethods = [...METHODS, METHOD_NAME_ALL_LOWERCASE];
    allMethods.forEach((method) => {
      this[method] = (args1, ...args) => {
        if (typeof args1 === "string") {
          this.#path = args1;
        } else {
          this.#addRoute(method, this.#path, args1);
        }
        args.forEach((handler) => {
          this.#addRoute(method, this.#path, handler);
        });
        return this;
      };
    });
    this.on = (method, path, ...handlers) => {
      for (const p of [path].flat()) {
        this.#path = p;
        for (const m of [method].flat()) {
          handlers.map((handler) => {
            this.#addRoute(m.toUpperCase(), this.#path, handler);
          });
        }
      }
      return this;
    };
    this.use = (arg1, ...handlers) => {
      if (typeof arg1 === "string") {
        this.#path = arg1;
      } else {
        this.#path = "*";
        handlers.unshift(arg1);
      }
      handlers.forEach((handler) => {
        this.#addRoute(METHOD_NAME_ALL, this.#path, handler);
      });
      return this;
    };
    const { strict, ...optionsWithoutStrict } = options;
    Object.assign(this, optionsWithoutStrict);
    this.getPath = strict ?? true ? options.getPath ?? getPath : getPathNoStrict;
  }
  #clone() {
    const clone = new _Hono({
      router: this.router,
      getPath: this.getPath
    });
    clone.errorHandler = this.errorHandler;
    clone.#notFoundHandler = this.#notFoundHandler;
    clone.routes = this.routes;
    return clone;
  }
  #notFoundHandler = notFoundHandler;
  errorHandler = errorHandler;
  route(path, app) {
    const subApp = this.basePath(path);
    app.routes.map((r) => {
      let handler;
      if (app.errorHandler === errorHandler) {
        handler = r.handler;
      } else {
        handler = async (c, next) => (await compose([], app.errorHandler)(c, () => r.handler(c, next))).res;
        handler[COMPOSED_HANDLER] = r.handler;
      }
      subApp.#addRoute(r.method, r.path, handler);
    });
    return this;
  }
  basePath(path) {
    const subApp = this.#clone();
    subApp._basePath = mergePath(this._basePath, path);
    return subApp;
  }
  onError = (handler) => {
    this.errorHandler = handler;
    return this;
  };
  notFound = (handler) => {
    this.#notFoundHandler = handler;
    return this;
  };
  mount(path, applicationHandler, options) {
    let replaceRequest;
    let optionHandler;
    if (options) {
      if (typeof options === "function") {
        optionHandler = options;
      } else {
        optionHandler = options.optionHandler;
        if (options.replaceRequest === false) {
          replaceRequest = (request) => request;
        } else {
          replaceRequest = options.replaceRequest;
        }
      }
    }
    const getOptions = optionHandler ? (c) => {
      const options2 = optionHandler(c);
      return Array.isArray(options2) ? options2 : [options2];
    } : (c) => {
      let executionContext = undefined;
      try {
        executionContext = c.executionCtx;
      } catch {}
      return [c.env, executionContext];
    };
    replaceRequest ||= (() => {
      const mergedPath = mergePath(this._basePath, path);
      const pathPrefixLength = mergedPath === "/" ? 0 : mergedPath.length;
      return (request) => {
        const url = new URL(request.url);
        url.pathname = url.pathname.slice(pathPrefixLength) || "/";
        return new Request(url, request);
      };
    })();
    const handler = async (c, next) => {
      const res = await applicationHandler(replaceRequest(c.req.raw), ...getOptions(c));
      if (res) {
        return res;
      }
      await next();
    };
    this.#addRoute(METHOD_NAME_ALL, mergePath(path, "*"), handler);
    return this;
  }
  #addRoute(method, path, handler) {
    method = method.toUpperCase();
    path = mergePath(this._basePath, path);
    const r = { basePath: this._basePath, path, method, handler };
    this.router.add(method, path, [handler, r]);
    this.routes.push(r);
  }
  #handleError(err, c) {
    if (err instanceof Error) {
      return this.errorHandler(err, c);
    }
    throw err;
  }
  #dispatch(request, executionCtx, env, method) {
    if (method === "HEAD") {
      return (async () => new Response(null, await this.#dispatch(request, executionCtx, env, "GET")))();
    }
    const path = this.getPath(request, { env });
    const matchResult = this.router.match(method, path);
    const c = new Context(request, {
      path,
      matchResult,
      env,
      executionCtx,
      notFoundHandler: this.#notFoundHandler
    });
    if (matchResult[0].length === 1) {
      let res;
      try {
        res = matchResult[0][0][0][0](c, async () => {
          c.res = await this.#notFoundHandler(c);
        });
      } catch (err) {
        return this.#handleError(err, c);
      }
      return res instanceof Promise ? res.then((resolved) => resolved || (c.finalized ? c.res : this.#notFoundHandler(c))).catch((err) => this.#handleError(err, c)) : res ?? this.#notFoundHandler(c);
    }
    const composed = compose(matchResult[0], this.errorHandler, this.#notFoundHandler);
    return (async () => {
      try {
        const context = await composed(c);
        if (!context.finalized) {
          throw new Error("Context is not finalized. Did you forget to return a Response object or `await next()`?");
        }
        return context.res;
      } catch (err) {
        return this.#handleError(err, c);
      }
    })();
  }
  fetch = (request, ...rest) => {
    return this.#dispatch(request, rest[1], rest[0], request.method);
  };
  request = (input, requestInit, Env, executionCtx) => {
    if (input instanceof Request) {
      return this.fetch(requestInit ? new Request(input, requestInit) : input, Env, executionCtx);
    }
    input = input.toString();
    return this.fetch(new Request(/^https?:\/\//.test(input) ? input : `http://localhost${mergePath("/", input)}`, requestInit), Env, executionCtx);
  };
  fire = () => {
    addEventListener("fetch", (event) => {
      event.respondWith(this.#dispatch(event.request, event, undefined, event.request.method));
    });
  };
};

// node_modules/hono/dist/router/reg-exp-router/matcher.js
var emptyParam = [];
function match(method, path) {
  const matchers = this.buildAllMatchers();
  const match2 = (method2, path2) => {
    const matcher = matchers[method2] || matchers[METHOD_NAME_ALL];
    const staticMatch = matcher[2][path2];
    if (staticMatch) {
      return staticMatch;
    }
    const match3 = path2.match(matcher[0]);
    if (!match3) {
      return [[], emptyParam];
    }
    const index = match3.indexOf("", 1);
    return [matcher[1][index], match3];
  };
  this.match = match2;
  return match2(method, path);
}

// node_modules/hono/dist/router/reg-exp-router/node.js
var LABEL_REG_EXP_STR = "[^/]+";
var ONLY_WILDCARD_REG_EXP_STR = ".*";
var TAIL_WILDCARD_REG_EXP_STR = "(?:|/.*)";
var PATH_ERROR = /* @__PURE__ */ Symbol();
var regExpMetaChars = new Set(".\\+*[^]$()");
function compareKey(a, b) {
  if (a.length === 1) {
    return b.length === 1 ? a < b ? -1 : 1 : -1;
  }
  if (b.length === 1) {
    return 1;
  }
  if (a === ONLY_WILDCARD_REG_EXP_STR || a === TAIL_WILDCARD_REG_EXP_STR) {
    return 1;
  } else if (b === ONLY_WILDCARD_REG_EXP_STR || b === TAIL_WILDCARD_REG_EXP_STR) {
    return -1;
  }
  if (a === LABEL_REG_EXP_STR) {
    return 1;
  } else if (b === LABEL_REG_EXP_STR) {
    return -1;
  }
  return a.length === b.length ? a < b ? -1 : 1 : b.length - a.length;
}
var Node = class _Node {
  #index;
  #varIndex;
  #children = /* @__PURE__ */ Object.create(null);
  insert(tokens, index, paramMap, context, pathErrorCheckOnly) {
    if (tokens.length === 0) {
      if (this.#index !== undefined) {
        throw PATH_ERROR;
      }
      if (pathErrorCheckOnly) {
        return;
      }
      this.#index = index;
      return;
    }
    const [token, ...restTokens] = tokens;
    const pattern = token === "*" ? restTokens.length === 0 ? ["", "", ONLY_WILDCARD_REG_EXP_STR] : ["", "", LABEL_REG_EXP_STR] : token === "/*" ? ["", "", TAIL_WILDCARD_REG_EXP_STR] : token.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
    let node;
    if (pattern) {
      const name = pattern[1];
      let regexpStr = pattern[2] || LABEL_REG_EXP_STR;
      if (name && pattern[2]) {
        if (regexpStr === ".*") {
          throw PATH_ERROR;
        }
        regexpStr = regexpStr.replace(/^\((?!\?:)(?=[^)]+\)$)/, "(?:");
        if (/\((?!\?:)/.test(regexpStr)) {
          throw PATH_ERROR;
        }
      }
      node = this.#children[regexpStr];
      if (!node) {
        if (Object.keys(this.#children).some((k) => k !== ONLY_WILDCARD_REG_EXP_STR && k !== TAIL_WILDCARD_REG_EXP_STR)) {
          throw PATH_ERROR;
        }
        if (pathErrorCheckOnly) {
          return;
        }
        node = this.#children[regexpStr] = new _Node;
        if (name !== "") {
          node.#varIndex = context.varIndex++;
        }
      }
      if (!pathErrorCheckOnly && name !== "") {
        paramMap.push([name, node.#varIndex]);
      }
    } else {
      node = this.#children[token];
      if (!node) {
        if (Object.keys(this.#children).some((k) => k.length > 1 && k !== ONLY_WILDCARD_REG_EXP_STR && k !== TAIL_WILDCARD_REG_EXP_STR)) {
          throw PATH_ERROR;
        }
        if (pathErrorCheckOnly) {
          return;
        }
        node = this.#children[token] = new _Node;
      }
    }
    node.insert(restTokens, index, paramMap, context, pathErrorCheckOnly);
  }
  buildRegExpStr() {
    const childKeys = Object.keys(this.#children).sort(compareKey);
    const strList = childKeys.map((k) => {
      const c = this.#children[k];
      return (typeof c.#varIndex === "number" ? `(${k})@${c.#varIndex}` : regExpMetaChars.has(k) ? `\\${k}` : k) + c.buildRegExpStr();
    });
    if (typeof this.#index === "number") {
      strList.unshift(`#${this.#index}`);
    }
    if (strList.length === 0) {
      return "";
    }
    if (strList.length === 1) {
      return strList[0];
    }
    return "(?:" + strList.join("|") + ")";
  }
};

// node_modules/hono/dist/router/reg-exp-router/trie.js
var Trie = class {
  #context = { varIndex: 0 };
  #root = new Node;
  insert(path, index, pathErrorCheckOnly) {
    const paramAssoc = [];
    const groups = [];
    for (let i = 0;; ) {
      let replaced = false;
      path = path.replace(/\{[^}]+\}/g, (m) => {
        const mark = `@\\${i}`;
        groups[i] = [mark, m];
        i++;
        replaced = true;
        return mark;
      });
      if (!replaced) {
        break;
      }
    }
    const tokens = path.match(/(?::[^\/]+)|(?:\/\*$)|./g) || [];
    for (let i = groups.length - 1;i >= 0; i--) {
      const [mark] = groups[i];
      for (let j = tokens.length - 1;j >= 0; j--) {
        if (tokens[j].indexOf(mark) !== -1) {
          tokens[j] = tokens[j].replace(mark, groups[i][1]);
          break;
        }
      }
    }
    this.#root.insert(tokens, index, paramAssoc, this.#context, pathErrorCheckOnly);
    return paramAssoc;
  }
  buildRegExp() {
    let regexp = this.#root.buildRegExpStr();
    if (regexp === "") {
      return [/^$/, [], []];
    }
    let captureIndex = 0;
    const indexReplacementMap = [];
    const paramReplacementMap = [];
    regexp = regexp.replace(/#(\d+)|@(\d+)|\.\*\$/g, (_, handlerIndex, paramIndex) => {
      if (handlerIndex !== undefined) {
        indexReplacementMap[++captureIndex] = Number(handlerIndex);
        return "$()";
      }
      if (paramIndex !== undefined) {
        paramReplacementMap[Number(paramIndex)] = ++captureIndex;
        return "";
      }
      return "";
    });
    return [new RegExp(`^${regexp}`), indexReplacementMap, paramReplacementMap];
  }
};

// node_modules/hono/dist/router/reg-exp-router/router.js
var nullMatcher = [/^$/, [], /* @__PURE__ */ Object.create(null)];
var wildcardRegExpCache = /* @__PURE__ */ Object.create(null);
function buildWildcardRegExp(path) {
  return wildcardRegExpCache[path] ??= new RegExp(path === "*" ? "" : `^${path.replace(/\/\*$|([.\\+*[^\]$()])/g, (_, metaChar) => metaChar ? `\\${metaChar}` : "(?:|/.*)")}$`);
}
function clearWildcardRegExpCache() {
  wildcardRegExpCache = /* @__PURE__ */ Object.create(null);
}
function buildMatcherFromPreprocessedRoutes(routes) {
  const trie = new Trie;
  const handlerData = [];
  if (routes.length === 0) {
    return nullMatcher;
  }
  const routesWithStaticPathFlag = routes.map((route) => [!/\*|\/:/.test(route[0]), ...route]).sort(([isStaticA, pathA], [isStaticB, pathB]) => isStaticA ? 1 : isStaticB ? -1 : pathA.length - pathB.length);
  const staticMap = /* @__PURE__ */ Object.create(null);
  for (let i = 0, j = -1, len = routesWithStaticPathFlag.length;i < len; i++) {
    const [pathErrorCheckOnly, path, handlers] = routesWithStaticPathFlag[i];
    if (pathErrorCheckOnly) {
      staticMap[path] = [handlers.map(([h]) => [h, /* @__PURE__ */ Object.create(null)]), emptyParam];
    } else {
      j++;
    }
    let paramAssoc;
    try {
      paramAssoc = trie.insert(path, j, pathErrorCheckOnly);
    } catch (e) {
      throw e === PATH_ERROR ? new UnsupportedPathError(path) : e;
    }
    if (pathErrorCheckOnly) {
      continue;
    }
    handlerData[j] = handlers.map(([h, paramCount]) => {
      const paramIndexMap = /* @__PURE__ */ Object.create(null);
      paramCount -= 1;
      for (;paramCount >= 0; paramCount--) {
        const [key, value] = paramAssoc[paramCount];
        paramIndexMap[key] = value;
      }
      return [h, paramIndexMap];
    });
  }
  const [regexp, indexReplacementMap, paramReplacementMap] = trie.buildRegExp();
  for (let i = 0, len = handlerData.length;i < len; i++) {
    for (let j = 0, len2 = handlerData[i].length;j < len2; j++) {
      const map = handlerData[i][j]?.[1];
      if (!map) {
        continue;
      }
      const keys = Object.keys(map);
      for (let k = 0, len3 = keys.length;k < len3; k++) {
        map[keys[k]] = paramReplacementMap[map[keys[k]]];
      }
    }
  }
  const handlerMap = [];
  for (const i in indexReplacementMap) {
    handlerMap[i] = handlerData[indexReplacementMap[i]];
  }
  return [regexp, handlerMap, staticMap];
}
function findMiddleware(middleware, path) {
  if (!middleware) {
    return;
  }
  for (const k of Object.keys(middleware).sort((a, b) => b.length - a.length)) {
    if (buildWildcardRegExp(k).test(path)) {
      return [...middleware[k]];
    }
  }
  return;
}
var RegExpRouter = class {
  name = "RegExpRouter";
  #middleware;
  #routes;
  constructor() {
    this.#middleware = { [METHOD_NAME_ALL]: /* @__PURE__ */ Object.create(null) };
    this.#routes = { [METHOD_NAME_ALL]: /* @__PURE__ */ Object.create(null) };
  }
  add(method, path, handler) {
    const middleware = this.#middleware;
    const routes = this.#routes;
    if (!middleware || !routes) {
      throw new Error(MESSAGE_MATCHER_IS_ALREADY_BUILT);
    }
    if (!middleware[method]) {
      [middleware, routes].forEach((handlerMap) => {
        handlerMap[method] = /* @__PURE__ */ Object.create(null);
        Object.keys(handlerMap[METHOD_NAME_ALL]).forEach((p) => {
          handlerMap[method][p] = [...handlerMap[METHOD_NAME_ALL][p]];
        });
      });
    }
    if (path === "/*") {
      path = "*";
    }
    const paramCount = (path.match(/\/:/g) || []).length;
    if (/\*$/.test(path)) {
      const re = buildWildcardRegExp(path);
      if (method === METHOD_NAME_ALL) {
        Object.keys(middleware).forEach((m) => {
          middleware[m][path] ||= findMiddleware(middleware[m], path) || findMiddleware(middleware[METHOD_NAME_ALL], path) || [];
        });
      } else {
        middleware[method][path] ||= findMiddleware(middleware[method], path) || findMiddleware(middleware[METHOD_NAME_ALL], path) || [];
      }
      Object.keys(middleware).forEach((m) => {
        if (method === METHOD_NAME_ALL || method === m) {
          Object.keys(middleware[m]).forEach((p) => {
            re.test(p) && middleware[m][p].push([handler, paramCount]);
          });
        }
      });
      Object.keys(routes).forEach((m) => {
        if (method === METHOD_NAME_ALL || method === m) {
          Object.keys(routes[m]).forEach((p) => re.test(p) && routes[m][p].push([handler, paramCount]));
        }
      });
      return;
    }
    const paths = checkOptionalParameter(path) || [path];
    for (let i = 0, len = paths.length;i < len; i++) {
      const path2 = paths[i];
      Object.keys(routes).forEach((m) => {
        if (method === METHOD_NAME_ALL || method === m) {
          routes[m][path2] ||= [
            ...findMiddleware(middleware[m], path2) || findMiddleware(middleware[METHOD_NAME_ALL], path2) || []
          ];
          routes[m][path2].push([handler, paramCount - len + i + 1]);
        }
      });
    }
  }
  match = match;
  buildAllMatchers() {
    const matchers = /* @__PURE__ */ Object.create(null);
    Object.keys(this.#routes).concat(Object.keys(this.#middleware)).forEach((method) => {
      matchers[method] ||= this.#buildMatcher(method);
    });
    this.#middleware = this.#routes = undefined;
    clearWildcardRegExpCache();
    return matchers;
  }
  #buildMatcher(method) {
    const routes = [];
    let hasOwnRoute = method === METHOD_NAME_ALL;
    [this.#middleware, this.#routes].forEach((r) => {
      const ownRoute = r[method] ? Object.keys(r[method]).map((path) => [path, r[method][path]]) : [];
      if (ownRoute.length !== 0) {
        hasOwnRoute ||= true;
        routes.push(...ownRoute);
      } else if (method !== METHOD_NAME_ALL) {
        routes.push(...Object.keys(r[METHOD_NAME_ALL]).map((path) => [path, r[METHOD_NAME_ALL][path]]));
      }
    });
    if (!hasOwnRoute) {
      return null;
    } else {
      return buildMatcherFromPreprocessedRoutes(routes);
    }
  }
};

// node_modules/hono/dist/router/reg-exp-router/prepared-router.js
var PreparedRegExpRouter = class {
  name = "PreparedRegExpRouter";
  #matchers;
  #relocateMap;
  constructor(matchers, relocateMap) {
    this.#matchers = matchers;
    this.#relocateMap = relocateMap;
  }
  #addWildcard(method, handlerData) {
    const matcher = this.#matchers[method];
    matcher[1].forEach((list) => list && list.push(handlerData));
    Object.values(matcher[2]).forEach((list) => list[0].push(handlerData));
  }
  #addPath(method, path, handler, indexes, map) {
    const matcher = this.#matchers[method];
    if (!map) {
      matcher[2][path][0].push([handler, {}]);
    } else {
      indexes.forEach((index) => {
        if (typeof index === "number") {
          matcher[1][index].push([handler, map]);
        } else {
          matcher[2][index || path][0].push([handler, map]);
        }
      });
    }
  }
  add(method, path, handler) {
    if (!this.#matchers[method]) {
      const all = this.#matchers[METHOD_NAME_ALL];
      const staticMap = {};
      for (const key in all[2]) {
        staticMap[key] = [all[2][key][0].slice(), emptyParam];
      }
      this.#matchers[method] = [
        all[0],
        all[1].map((list) => Array.isArray(list) ? list.slice() : 0),
        staticMap
      ];
    }
    if (path === "/*" || path === "*") {
      const handlerData = [handler, {}];
      if (method === METHOD_NAME_ALL) {
        for (const m in this.#matchers) {
          this.#addWildcard(m, handlerData);
        }
      } else {
        this.#addWildcard(method, handlerData);
      }
      return;
    }
    const data = this.#relocateMap[path];
    if (!data) {
      throw new Error(`Path ${path} is not registered`);
    }
    for (const [indexes, map] of data) {
      if (method === METHOD_NAME_ALL) {
        for (const m in this.#matchers) {
          this.#addPath(m, path, handler, indexes, map);
        }
      } else {
        this.#addPath(method, path, handler, indexes, map);
      }
    }
  }
  buildAllMatchers() {
    return this.#matchers;
  }
  match = match;
};

// node_modules/hono/dist/router/smart-router/router.js
var SmartRouter = class {
  name = "SmartRouter";
  #routers = [];
  #routes = [];
  constructor(init) {
    this.#routers = init.routers;
  }
  add(method, path, handler) {
    if (!this.#routes) {
      throw new Error(MESSAGE_MATCHER_IS_ALREADY_BUILT);
    }
    this.#routes.push([method, path, handler]);
  }
  match(method, path) {
    if (!this.#routes) {
      throw new Error("Fatal error");
    }
    const routers = this.#routers;
    const routes = this.#routes;
    const len = routers.length;
    let i = 0;
    let res;
    for (;i < len; i++) {
      const router = routers[i];
      try {
        for (let i2 = 0, len2 = routes.length;i2 < len2; i2++) {
          router.add(...routes[i2]);
        }
        res = router.match(method, path);
      } catch (e) {
        if (e instanceof UnsupportedPathError) {
          continue;
        }
        throw e;
      }
      this.match = router.match.bind(router);
      this.#routers = [router];
      this.#routes = undefined;
      break;
    }
    if (i === len) {
      throw new Error("Fatal error");
    }
    this.name = `SmartRouter + ${this.activeRouter.name}`;
    return res;
  }
  get activeRouter() {
    if (this.#routes || this.#routers.length !== 1) {
      throw new Error("No active router has been determined yet.");
    }
    return this.#routers[0];
  }
};

// node_modules/hono/dist/router/trie-router/node.js
var emptyParams = /* @__PURE__ */ Object.create(null);
var hasChildren = (children) => {
  for (const _ in children) {
    return true;
  }
  return false;
};
var Node2 = class _Node2 {
  #methods;
  #children;
  #patterns;
  #order = 0;
  #params = emptyParams;
  constructor(method, handler, children) {
    this.#children = children || /* @__PURE__ */ Object.create(null);
    this.#methods = [];
    if (method && handler) {
      const m = /* @__PURE__ */ Object.create(null);
      m[method] = { handler, possibleKeys: [], score: 0 };
      this.#methods = [m];
    }
    this.#patterns = [];
  }
  insert(method, path, handler) {
    this.#order = ++this.#order;
    let curNode = this;
    const parts = splitRoutingPath(path);
    const possibleKeys = [];
    for (let i = 0, len = parts.length;i < len; i++) {
      const p = parts[i];
      const nextP = parts[i + 1];
      const pattern = getPattern(p, nextP);
      const key = Array.isArray(pattern) ? pattern[0] : p;
      if (key in curNode.#children) {
        curNode = curNode.#children[key];
        if (pattern) {
          possibleKeys.push(pattern[1]);
        }
        continue;
      }
      curNode.#children[key] = new _Node2;
      if (pattern) {
        curNode.#patterns.push(pattern);
        possibleKeys.push(pattern[1]);
      }
      curNode = curNode.#children[key];
    }
    curNode.#methods.push({
      [method]: {
        handler,
        possibleKeys: possibleKeys.filter((v, i, a) => a.indexOf(v) === i),
        score: this.#order
      }
    });
    return curNode;
  }
  #pushHandlerSets(handlerSets, node, method, nodeParams, params) {
    for (let i = 0, len = node.#methods.length;i < len; i++) {
      const m = node.#methods[i];
      const handlerSet = m[method] || m[METHOD_NAME_ALL];
      const processedSet = {};
      if (handlerSet !== undefined) {
        handlerSet.params = /* @__PURE__ */ Object.create(null);
        handlerSets.push(handlerSet);
        if (nodeParams !== emptyParams || params && params !== emptyParams) {
          for (let i2 = 0, len2 = handlerSet.possibleKeys.length;i2 < len2; i2++) {
            const key = handlerSet.possibleKeys[i2];
            const processed = processedSet[handlerSet.score];
            handlerSet.params[key] = params?.[key] && !processed ? params[key] : nodeParams[key] ?? params?.[key];
            processedSet[handlerSet.score] = true;
          }
        }
      }
    }
  }
  search(method, path) {
    const handlerSets = [];
    this.#params = emptyParams;
    const curNode = this;
    let curNodes = [curNode];
    const parts = splitPath(path);
    const curNodesQueue = [];
    const len = parts.length;
    let partOffsets = null;
    for (let i = 0;i < len; i++) {
      const part = parts[i];
      const isLast = i === len - 1;
      const tempNodes = [];
      for (let j = 0, len2 = curNodes.length;j < len2; j++) {
        const node = curNodes[j];
        const nextNode = node.#children[part];
        if (nextNode) {
          nextNode.#params = node.#params;
          if (isLast) {
            if (nextNode.#children["*"]) {
              this.#pushHandlerSets(handlerSets, nextNode.#children["*"], method, node.#params);
            }
            this.#pushHandlerSets(handlerSets, nextNode, method, node.#params);
          } else {
            tempNodes.push(nextNode);
          }
        }
        for (let k = 0, len3 = node.#patterns.length;k < len3; k++) {
          const pattern = node.#patterns[k];
          const params = node.#params === emptyParams ? {} : { ...node.#params };
          if (pattern === "*") {
            const astNode = node.#children["*"];
            if (astNode) {
              this.#pushHandlerSets(handlerSets, astNode, method, node.#params);
              astNode.#params = params;
              tempNodes.push(astNode);
            }
            continue;
          }
          const [key, name, matcher] = pattern;
          if (!part && !(matcher instanceof RegExp)) {
            continue;
          }
          const child = node.#children[key];
          if (matcher instanceof RegExp) {
            if (partOffsets === null) {
              partOffsets = new Array(len);
              let offset = path[0] === "/" ? 1 : 0;
              for (let p = 0;p < len; p++) {
                partOffsets[p] = offset;
                offset += parts[p].length + 1;
              }
            }
            const restPathString = path.substring(partOffsets[i]);
            const m = matcher.exec(restPathString);
            if (m) {
              params[name] = m[0];
              this.#pushHandlerSets(handlerSets, child, method, node.#params, params);
              if (hasChildren(child.#children)) {
                child.#params = params;
                const componentCount = m[0].match(/\//)?.length ?? 0;
                const targetCurNodes = curNodesQueue[componentCount] ||= [];
                targetCurNodes.push(child);
              }
              continue;
            }
          }
          if (matcher === true || matcher.test(part)) {
            params[name] = part;
            if (isLast) {
              this.#pushHandlerSets(handlerSets, child, method, params, node.#params);
              if (child.#children["*"]) {
                this.#pushHandlerSets(handlerSets, child.#children["*"], method, params, node.#params);
              }
            } else {
              child.#params = params;
              tempNodes.push(child);
            }
          }
        }
      }
      const shifted = curNodesQueue.shift();
      curNodes = shifted ? tempNodes.concat(shifted) : tempNodes;
    }
    if (handlerSets.length > 1) {
      handlerSets.sort((a, b) => {
        return a.score - b.score;
      });
    }
    return [handlerSets.map(({ handler, params }) => [handler, params])];
  }
};

// node_modules/hono/dist/router/trie-router/router.js
var TrieRouter = class {
  name = "TrieRouter";
  #node;
  constructor() {
    this.#node = new Node2;
  }
  add(method, path, handler) {
    const results = checkOptionalParameter(path);
    if (results) {
      for (let i = 0, len = results.length;i < len; i++) {
        this.#node.insert(method, results[i], handler);
      }
      return;
    }
    this.#node.insert(method, path, handler);
  }
  match(method, path) {
    return this.#node.search(method, path);
  }
};

// node_modules/hono/dist/hono.js
var Hono2 = class extends Hono {
  constructor(options = {}) {
    super(options);
    this.router = options.router ?? new SmartRouter({
      routers: [new RegExpRouter, new TrieRouter]
    });
  }
};

// src/server.ts
import { brotliDecompressSync, gunzipSync, inflateSync } from "zlib";

// src/auth.ts
import { readFileSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
var AUTH_PATH = process.env.CODEX_PROXY_AUTH_FILE || join(homedir(), ".codex", "auth.json");
var TOKEN_URL = "https://auth.openai.com/oauth/token";
var CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
var EXPIRY_BUFFER_MS = 60000;
var API_KEY_FILE_PATH = process.env.CODEX_PROXY_API_KEY_FILE || null;
var API_KEY_ENV = process.env.OPENAI_API_KEY || null;
var cached = null;
var refreshing = null;
function coerceEpochMs(value) {
  if (!value || !Number.isFinite(value))
    return 0;
  return value > 1000000000000 ? value : value * 1000;
}
function decodeJwtPayload(token) {
  if (!token)
    return null;
  const [, payload] = token.split(".");
  if (!payload)
    return null;
  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + (4 - normalized.length % 4) % 4, "=");
  try {
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}
function extractClaimObject(payload) {
  const claim = payload?.["https://api.openai.com/auth"];
  return claim && typeof claim === "object" ? claim : null;
}
function extractScopes(payload) {
  const scopes = payload?.scp;
  return Array.isArray(scopes) ? scopes.filter((scope) => typeof scope === "string") : [];
}
function deriveExpiryMs(token, explicitExpiry) {
  const fromFile = coerceEpochMs(explicitExpiry);
  if (fromFile > 0)
    return fromFile;
  const payload = decodeJwtPayload(token);
  const jwtExp = typeof payload?.exp === "number" ? payload.exp : 0;
  return coerceEpochMs(jwtExp);
}
function readString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
function toAuthState(data) {
  const accessToken = readString(data.tokens?.access_token);
  if (!accessToken) {
    throw new Error(`Missing access token in ${AUTH_PATH}`);
  }
  const payload = decodeJwtPayload(accessToken);
  const claim = extractClaimObject(payload);
  const accountId = readString(data.tokens?.account_id) || readString(data.account_id) || readString(claim?.chatgpt_account_id);
  const organizationId = readString(data.tokens?.organization_id) || readString(data.tokens?.org_id) || readString(data.tokens?.openai_organization) || readString(data.organization_id) || readString(data.org_id) || readString(data.openai_organization) || readString(claim?.organization_id) || readString(claim?.allowed_workspace_id);
  return {
    accessToken,
    refreshToken: readString(data.tokens?.refresh_token) || "",
    accountId,
    organizationId,
    expiresAt: deriveExpiryMs(accessToken, data.tokens?.expires_at),
    authMode: readString(data.auth_mode),
    scopes: extractScopes(payload)
  };
}
async function readAuthFile() {
  const raw2 = await readFile(AUTH_PATH, "utf8");
  return JSON.parse(raw2);
}
function isFresh(expiresAt) {
  return expiresAt > 0 && Date.now() < expiresAt - EXPIRY_BUFFER_MS;
}
async function loadStoredState() {
  return toAuthState(await readAuthFile());
}
async function persistAuthFile(base, refresh, previous) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresAtSeconds = typeof refresh.expires_at === "number" ? Math.floor(refresh.expires_at) : typeof refresh.expires_in === "number" ? nowSeconds + refresh.expires_in : 0;
  const next = {
    ...base,
    last_refresh: new Date().toISOString(),
    tokens: {
      ...base.tokens || {},
      access_token: refresh.access_token || previous.accessToken,
      refresh_token: refresh.refresh_token || previous.refreshToken,
      expires_at: expiresAtSeconds || base.tokens?.expires_at || null,
      account_id: refresh.account_id || base.tokens?.account_id,
      id_token: refresh.id_token || base.tokens?.id_token
    }
  };
  await writeFile(AUTH_PATH, JSON.stringify(next, null, 2) + `
`);
  return toAuthState(next);
}
function formatUpstreamError(status, rawBody) {
  try {
    const parsed = JSON.parse(rawBody);
    const error = parsed.error;
    if (typeof error?.message === "string") {
      return `${status}: ${error.message}`;
    }
  } catch {}
  return `${status}: ${rawBody.slice(0, 400)}`;
}
async function refreshState(current) {
  if (!current.refreshToken) {
    throw new Error("No refresh token available");
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      client_id: CLIENT_ID
    }),
    signal: AbortSignal.timeout(1e4)
  });
  if (!res.ok) {
    throw new Error(`Token refresh failed (${formatUpstreamError(res.status, await res.text())})`);
  }
  const refresh = await res.json();
  if (!refresh.access_token) {
    throw new Error("Refresh response did not include an access token");
  }
  const base = await readAuthFile();
  return persistAuthFile(base, refresh, current);
}
async function getAuthState() {
  if (!cached) {
    cached = await loadStoredState();
  }
  if (!isFresh(cached.expiresAt)) {
    if (cached.refreshToken) {
      if (!refreshing) {
        refreshing = refreshState(cached).catch(async (error) => {
          const latest = await loadStoredState();
          if (isFresh(latest.expiresAt)) {
            return latest;
          }
          throw error;
        }).finally(() => {
          refreshing = null;
        });
      }
      cached = await refreshing;
    } else {
      const latest = await loadStoredState();
      if (isFresh(latest.expiresAt)) {
        cached = latest;
      } else {
        throw new Error("OAuth token is expired and no refresh token is available");
      }
    }
  }
  return cached;
}
async function getStoredAuthInfo() {
  return getAuthState();
}
function getAuthPath() {
  return AUTH_PATH;
}
async function invalidateAndRefresh() {
  cached = null;
  return getAuthState();
}
var cachedFileKey = null;
var cachedEnvKey = null;
function loadAuthFileKey() {
  try {
    const raw2 = readFileSync(AUTH_PATH, "utf8");
    const parsed = JSON.parse(raw2);
    const inferredKey = readString(parsed.OPENAI_API_KEY) || readString(parsed.api_key) || readString(parsed.tokens?.OPENAI_API_KEY);
    if (!inferredKey)
      return null;
    const authMode = readString(parsed.auth_mode);
    const looksLikeApiKey = inferredKey.startsWith("sk-");
    if (authMode === "apikey" || authMode === "api_key" || looksLikeApiKey) {
      return { value: inferredKey, path: AUTH_PATH, loadedAt: new Date().toISOString() };
    }
    return null;
  } catch {
    return null;
  }
}
function loadFileKeyOnce() {
  if (cachedFileKey)
    return cachedFileKey;
  if (!API_KEY_FILE_PATH)
    return null;
  try {
    const raw2 = readFileSync(API_KEY_FILE_PATH, "utf8").trim();
    if (!raw2)
      return null;
    cachedFileKey = { value: raw2, path: API_KEY_FILE_PATH, loadedAt: new Date().toISOString() };
    return cachedFileKey;
  } catch (error) {
    console.error(`[auth] failed to read CODEX_PROXY_API_KEY_FILE=${API_KEY_FILE_PATH}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
function loadEnvKeyOnce() {
  if (cachedEnvKey)
    return cachedEnvKey;
  if (!API_KEY_ENV)
    return null;
  cachedEnvKey = { value: API_KEY_ENV, loadedAt: new Date().toISOString() };
  return cachedEnvKey;
}
function previewKey(key) {
  if (key.length <= 8)
    return "***";
  const tail = key.slice(-3);
  const dash = key.indexOf("-");
  if (dash >= 0 && dash < key.length - 4) {
    const head = key.slice(0, dash + 4);
    return `${head}\u2026${tail}`;
  }
  return `${key.slice(0, 4)}\u2026${tail}`;
}
function resolveApiKey(profileKey, profileName) {
  if (profileKey && typeof profileKey === "string" && profileKey.length > 0) {
    return {
      key: profileKey,
      source: "profile",
      sourceDetail: profileName ? `profile:${profileName}` : "profile",
      preview: previewKey(profileKey),
      length: profileKey.length,
      loadedAt: new Date().toISOString()
    };
  }
  const fileKey = loadFileKeyOnce();
  if (fileKey) {
    return {
      key: fileKey.value,
      source: "file",
      sourceDetail: `file:${fileKey.path}`,
      preview: previewKey(fileKey.value),
      length: fileKey.value.length,
      loadedAt: fileKey.loadedAt
    };
  }
  const authFileKey = loadAuthFileKey();
  if (authFileKey) {
    return {
      key: authFileKey.value,
      source: "auth_file",
      sourceDetail: `auth_file:${authFileKey.path}`,
      preview: previewKey(authFileKey.value),
      length: authFileKey.value.length,
      loadedAt: authFileKey.loadedAt
    };
  }
  const envKey = loadEnvKeyOnce();
  if (envKey) {
    return {
      key: envKey.value,
      source: "env",
      sourceDetail: "env",
      preview: previewKey(envKey.value),
      length: envKey.value.length,
      loadedAt: envKey.loadedAt
    };
  }
  return null;
}
function getApiKeyFilePath() {
  return API_KEY_FILE_PATH;
}
function isApiKeyEnvSet() {
  return !!API_KEY_ENV;
}
var cachedAuthFileMode = undefined;
function getAuthFileMode() {
  if (cachedAuthFileMode !== undefined)
    return cachedAuthFileMode;
  try {
    const raw2 = readFileSync(AUTH_PATH, "utf8");
    const parsed = JSON.parse(raw2);
    const m = (readString(parsed.auth_mode) || "").toLowerCase();
    if (m === "apikey" || m === "api_key") {
      cachedAuthFileMode = "api_key";
    } else if (m === "oauth" || m === "chatgpt") {
      cachedAuthFileMode = "oauth";
    } else if (parsed.tokens?.access_token) {
      cachedAuthFileMode = "oauth";
    } else if (parsed.OPENAI_API_KEY || parsed.api_key) {
      cachedAuthFileMode = "api_key";
    } else {
      cachedAuthFileMode = null;
    }
  } catch {
    cachedAuthFileMode = null;
  }
  return cachedAuthFileMode;
}

// src/harmony.ts
import { createHash } from "crypto";
var TIER_VALUES = new Set([
  "system",
  "developer",
  "user",
  "assistant",
  "tool",
  "compaction",
  "reasoning",
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output"
]);
function channelForEventType(type) {
  if (typeof type !== "string" || type.length === 0)
    return null;
  if (type.includes("output_text"))
    return "final";
  if (type.includes("reasoning_text") || type.includes("reasoning_summary"))
    return "analysis";
  if (type.includes("function_call_arguments") || type.includes("custom_tool_call_input"))
    return "commentary";
  return null;
}
function tierForInputItem(item) {
  if (!item || typeof item !== "object")
    return null;
  const candidates = [item.role, item.type];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && TIER_VALUES.has(candidate)) {
      return candidate;
    }
  }
  if (item.type === "message" && typeof item.role === "string" && TIER_VALUES.has(item.role)) {
    return item.role;
  }
  return null;
}
function extractTextFromInputItem(item) {
  if (!item || typeof item !== "object")
    return "";
  const content = item.content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (part && typeof part === "object" && typeof part.text === "string") {
        parts.push(part.text);
      }
    }
    if (parts.length > 0)
      return parts.join("");
  }
  if (typeof item.text === "string")
    return item.text;
  if (typeof item.output === "string")
    return item.output;
  if (typeof item.input === "string")
    return item.input;
  if (typeof item.arguments === "string")
    return item.arguments;
  return "";
}
var PERMISSIONS_BLOCK_RE = /<permissions instructions>([\s\S]*?)<\/permissions instructions>/i;
function parsePermissionsBlock(text) {
  if (typeof text !== "string" || text.length === 0)
    return null;
  const match2 = PERMISSIONS_BLOCK_RE.exec(text);
  if (!match2)
    return null;
  const raw2 = match2[1].trim();
  const sandbox = /`?sandbox_mode`?\s+is\s+`?([a-zA-Z0-9_-]+)`?/i.exec(raw2);
  const network = /[Nn]etwork access is\s+(enabled|disabled|restricted)/i.exec(raw2);
  const approval = /[Aa]pproval policy is(?:\s+currently)?\s+([a-zA-Z0-9_-]+)/i.exec(raw2);
  let networkAccess = null;
  if (network) {
    const v = network[1].toLowerCase();
    networkAccess = v === "enabled" ? true : v === "disabled" ? false : null;
  }
  return {
    sandboxMode: sandbox ? sandbox[1] : null,
    networkAccess,
    approvalPolicy: approval ? approval[1] : null,
    raw: raw2
  };
}
function hashContent(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

// src/hooks.ts
import { isAbsolute } from "path";
var NOOP_HOOKS = {};
var cached2 = null;
async function loadHooks() {
  if (cached2)
    return cached2;
  const modulePath = process.env.CODEX_PROXY_HOOK_MODULE;
  if (!modulePath) {
    cached2 = NOOP_HOOKS;
    return cached2;
  }
  if (!isAbsolute(modulePath)) {
    console.error(`[proxy] CODEX_PROXY_HOOK_MODULE must be an absolute path; got ${modulePath}`);
    cached2 = NOOP_HOOKS;
    return cached2;
  }
  try {
    const mod = await import(modulePath);
    const hooks = mod && (mod.hooks || mod.default || mod);
    if (!hooks || typeof hooks !== "object") {
      console.error(`[proxy] hook module ${modulePath} did not export an object`);
      cached2 = NOOP_HOOKS;
      return cached2;
    }
    const fns = [];
    if (typeof hooks.onRequest === "function")
      fns.push("onRequest");
    if (typeof hooks.onSseEvent === "function")
      fns.push("onSseEvent");
    if (typeof hooks.onResponseComplete === "function")
      fns.push("onResponseComplete");
    console.log(`[proxy] loaded hooks from ${modulePath} (${fns.join(", ") || "none"})`);
    cached2 = hooks;
    return cached2;
  } catch (error) {
    console.error(`[proxy] failed to load hook module ${modulePath}: ${error instanceof Error ? error.message : String(error)}`);
    cached2 = NOOP_HOOKS;
    return cached2;
  }
}

// src/profiles.ts
import { readFileSync as readFileSync2 } from "fs";

class ProfileError extends Error {
  status;
  reason;
  constructor(reason, status = 403) {
    super(reason);
    this.reason = reason;
    this.status = status;
  }
}
function parseIdentifyRule(spec) {
  if (spec === "remote-ip")
    return { kind: "remote-ip" };
  if (spec === "default")
    return { kind: "default" };
  const headerMatch = /^header:([\w-]+)$/i.exec(spec);
  if (headerMatch)
    return { kind: "header", header: headerMatch[1].toLowerCase() };
  const bearerMatch = /^header-bearer:([\w-]+)$/i.exec(spec);
  if (bearerMatch)
    return { kind: "header-bearer", header: bearerMatch[1].toLowerCase() };
  throw new Error(`Unknown identifyBy spec: ${spec}`);
}
function loadProfilesConfig(path) {
  const raw2 = readFileSync2(path, "utf8");
  const data = JSON.parse(raw2);
  const identifyBy = Array.isArray(data.identifyBy) ? data.identifyBy.map((r) => {
    if (typeof r === "string")
      return parseIdentifyRule(r);
    if (r && typeof r === "object" && r.kind)
      return r;
    throw new Error(`Invalid identifyBy entry: ${JSON.stringify(r)}`);
  }) : [{ kind: "header", header: "x-codex-proxy-profile" }, { kind: "default" }];
  const profiles = data.profiles || {};
  const defaultName = data.default || Object.keys(profiles)[0];
  if (!profiles[defaultName]) {
    throw new Error(`Default profile "${defaultName}" not found in profiles config`);
  }
  return {
    identifyBy,
    default: defaultName,
    ipMap: data.ipMap || {},
    bearerMap: data.bearerMap || {},
    profiles
  };
}
function identifyProfile(config, ctx) {
  for (const rule of config.identifyBy) {
    if (rule.kind === "header") {
      const value = ctx.headers[rule.header];
      if (value && config.profiles[value]) {
        return { name: value, def: config.profiles[value], matchedBy: `header:${rule.header}=${value}` };
      }
    } else if (rule.kind === "header-bearer") {
      const value = ctx.headers[rule.header];
      if (value) {
        const m = /^Bearer\s+(.+)$/i.exec(value);
        const token = m ? m[1] : value;
        const mapped = config.bearerMap?.[token];
        if (mapped && config.profiles[mapped]) {
          return { name: mapped, def: config.profiles[mapped], matchedBy: `header-bearer:${rule.header}` };
        }
      }
    } else if (rule.kind === "remote-ip") {
      if (ctx.remoteIp) {
        const mapped = config.ipMap?.[ctx.remoteIp];
        if (mapped && config.profiles[mapped]) {
          return { name: mapped, def: config.profiles[mapped], matchedBy: `remote-ip:${ctx.remoteIp}` };
        }
      }
    } else if (rule.kind === "default") {
      return { name: config.default, def: config.profiles[config.default], matchedBy: "default" };
    }
  }
  return { name: config.default, def: config.profiles[config.default], matchedBy: "default-fallback" };
}
function tagBlockRegex(tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, (ch) => `\\${ch}`);
  const flexible = escaped.replace(/[\s_-]+/g, "[\\s_-]+");
  return new RegExp(`<${flexible}(?:\\s[^>]*)?>[\\s\\S]*?</${flexible}\\s*>\\s*`, "gi");
}
function dropBlocksFromText(text, tagNames) {
  if (!tagNames || tagNames.length === 0)
    return { text, droppedBlocks: [] };
  let out = text;
  const dropped = [];
  for (const tag of tagNames) {
    const re = tagBlockRegex(tag);
    const matches = out.match(re);
    if (matches && matches.length > 0) {
      for (const _ of matches)
        dropped.push(tag);
      out = out.replace(re, "");
    }
  }
  return { text: out.trim(), droppedBlocks: dropped };
}
function scrubDeveloperBlocks(input, tagNames) {
  if (!Array.isArray(input) || !tagNames || tagNames.length === 0) {
    return { input, itemsScrubbed: 0, partsRemoved: 0, itemsRemoved: 0, blocksDropped: [] };
  }
  const result = [];
  let itemsScrubbed = 0;
  let partsRemoved = 0;
  let itemsRemoved = 0;
  const blocksDropped = [];
  for (const item of input) {
    if (!item || typeof item !== "object" || item.role !== "developer" || !Array.isArray(item.content)) {
      result.push(item);
      continue;
    }
    let mutated = false;
    const newContent = [];
    for (const part of item.content) {
      if (!part || typeof part !== "object" || typeof part.text !== "string") {
        newContent.push(part);
        continue;
      }
      const { text: scrubbed, droppedBlocks } = dropBlocksFromText(part.text, tagNames);
      if (droppedBlocks.length > 0) {
        mutated = true;
        blocksDropped.push(...droppedBlocks);
      }
      if (scrubbed.length === 0) {
        partsRemoved += 1;
      } else if (scrubbed === part.text) {
        newContent.push(part);
      } else {
        newContent.push({ ...part, text: scrubbed });
      }
    }
    if (mutated)
      itemsScrubbed += 1;
    if (newContent.length === 0) {
      itemsRemoved += 1;
      continue;
    }
    result.push(newContent === item.content ? item : { ...item, content: newContent });
  }
  return { input: result, itemsScrubbed, partsRemoved, itemsRemoved, blocksDropped };
}
function applyInstructionsMode(current, ours, mode) {
  if (!ours || ours.length === 0)
    return { result: current, applied: false, mode: "replace" };
  const m = mode || "replace";
  switch (m) {
    case "replace":
      return { result: ours, applied: true, mode: m };
    case "prepend":
      return { result: current ? `${ours}

${current}` : ours, applied: true, mode: m };
    case "append":
      return { result: current ? `${current}

${ours}` : ours, applied: true, mode: m };
    case "wrap":
      return { result: `[BEGIN_PROXY_INSTRUCTIONS]
${ours}
[END_PROXY_INSTRUCTIONS]

${current || ""}`.trim(), applied: true, mode: m };
  }
}
function applySystemMessageMode(currentSystem, ours, mode) {
  if (!ours || ours.length === 0)
    return { result: currentSystem, applied: false, mode: "replace" };
  const m = mode || "replace";
  switch (m) {
    case "replace":
      return { result: ours, applied: true, mode: m };
    case "prepend":
      return { result: currentSystem ? `${ours}

${currentSystem}` : ours, applied: true, mode: m };
    case "append":
      return { result: currentSystem ? `${currentSystem}

${ours}` : ours, applied: true, mode: m };
    case "wrap":
      return { result: `[BEGIN_PROXY_INSTRUCTIONS]
${ours}
[END_PROXY_INSTRUCTIONS]

${currentSystem || ""}`.trim(), applied: true, mode: m };
  }
}
function mutateMessagesSystemPrompt(messages, ours, mode) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages, applied: false, mode: "replace", originalLen: 0, finalLen: 0 };
  }
  const first = messages[0];
  if (!first || typeof first !== "object") {
    return { messages, applied: false, mode: "replace", originalLen: 0, finalLen: 0 };
  }
  let currentText = "";
  if (first.role === "system") {
    if (typeof first.content === "string") {
      currentText = first.content;
    } else if (Array.isArray(first.content)) {
      currentText = first.content.filter((p) => p && typeof p === "object" && typeof p.text === "string").map((p) => p.text).join("");
    }
  }
  const { result, applied, mode: resolvedMode } = applySystemMessageMode(currentText, ours, mode);
  if (!applied) {
    return { messages, applied: false, mode: resolvedMode, originalLen: currentText.length, finalLen: currentText.length };
  }
  const newFirst = { ...first, role: "system", content: result };
  const newMessages = first.role === "system" ? [newFirst, ...messages.slice(1)] : [newFirst, ...messages];
  return { messages: newMessages, applied: true, mode: resolvedMode, originalLen: currentText.length, finalLen: result.length };
}
function applyProfileGates(body, profile) {
  if (profile.def.rejectWrites) {
    throw new ProfileError(`profile "${profile.name}" is read-only and cannot make Responses-API calls`, 403);
  }
  const next = { ...body };
  const writeRoles = new Set(profile.def.writeRoles);
  const blockedTools = new Set(profile.def.blockedTools || []);
  const onUnauthorized = profile.def.onUnauthorizedRole || "demote";
  let demoted = 0;
  let contentTruncated = 0;
  let developerBlocksDropped = null;
  if (profile.def.dropDeveloperBlocks && profile.def.dropDeveloperBlocks.length > 0) {
    const arr = normalizeProfileInput(next.input);
    const r = scrubDeveloperBlocks(arr, profile.def.dropDeveloperBlocks);
    if (r.itemsScrubbed > 0 || r.itemsRemoved > 0) {
      next.input = r.input;
      developerBlocksDropped = {
        blocks: [...new Set(r.blocksDropped)],
        itemsScrubbed: r.itemsScrubbed,
        partsRemoved: r.partsRemoved,
        itemsRemoved: r.itemsRemoved
      };
    }
  }
  const inputArr = normalizeProfileInput(next.input);
  const filteredInput = [];
  for (const item of inputArr) {
    if (!item || typeof item !== "object") {
      filteredInput.push(item);
      continue;
    }
    const role = typeof item.role === "string" ? item.role : item.type;
    if (!role || writeRoles.has(role)) {
      filteredInput.push(applyContentCap(item, profile.def.contentMaxBytes, (n) => contentTruncated += n));
      continue;
    }
    if (role === "function_call" || role === "function_call_output" || role === "custom_tool_call" || role === "custom_tool_call_output" || role === "reasoning" || role === "compaction") {
      filteredInput.push(item);
      continue;
    }
    if (onUnauthorized === "reject") {
      throw new ProfileError(`profile "${profile.name}" cannot write role "${role}"`, 403);
    }
    demoted += 1;
    filteredInput.push({
      ...item,
      role: "user",
      type: "message"
    });
  }
  next.input = filteredInput;
  let prefixInjected = false;
  if (profile.def.developerPrefix && profile.def.developerPrefix.length > 0) {
    next.input = [
      {
        role: "developer",
        type: "message",
        content: [{ type: "input_text", text: profile.def.developerPrefix }]
      },
      ...next.input
    ];
    prefixInjected = true;
  }
  const toolsRemoved = [];
  if (Array.isArray(next.tools)) {
    next.tools = next.tools.filter((t) => {
      if (!t || typeof t !== "object")
        return true;
      const name = typeof t.name === "string" ? t.name : typeof t.type === "string" ? t.type : null;
      if (!name)
        return true;
      if (profile.def.tools !== "*" && !profile.def.tools.includes(name)) {
        toolsRemoved.push(name);
        return false;
      }
      if (blockedTools.has(name)) {
        toolsRemoved.push(name);
        return false;
      }
      return true;
    });
  }
  const { body: overridden, applied: bodyOverridesApplied } = applyBodyOverrides(next, profile.def.bodyOverrides);
  let instructionsMutation = null;
  if (profile.def.instructions && profile.def.instructions.length > 0) {
    const before = typeof overridden.instructions === "string" ? overridden.instructions : "";
    const { result, applied, mode } = applyInstructionsMode(before, profile.def.instructions, profile.def.instructionsMode);
    if (applied) {
      overridden.instructions = result;
      instructionsMutation = { mode, originalLen: before.length, finalLen: result.length };
    }
  }
  let systemMessageMutation = null;
  if (profile.def.systemMessage && profile.def.systemMessage.length > 0 && Array.isArray(overridden.messages)) {
    const r = mutateMessagesSystemPrompt(overridden.messages, profile.def.systemMessage, profile.def.systemMessageMode);
    if (r.applied) {
      overridden.messages = r.messages;
      systemMessageMutation = { mode: r.mode, originalLen: r.originalLen, finalLen: r.finalLen };
    }
  }
  let toolsStripped = false;
  let toolChoiceForced = false;
  if (profile.def.stripTools && Array.isArray(overridden.tools)) {
    delete overridden.tools;
    toolsStripped = true;
  }
  if (profile.def.disableToolForcing) {
    overridden.tool_choice = "none";
    toolChoiceForced = true;
  }
  return {
    body: overridden,
    demoted,
    toolsRemoved,
    contentTruncated,
    prefixInjected,
    bodyOverridesApplied,
    instructionsMutation,
    developerBlocksDropped,
    systemMessageMutation,
    toolsStripped,
    toolChoiceForced
  };
}
function normalizeProfileInput(value) {
  if (Array.isArray(value))
    return value;
  if (typeof value === "string") {
    return [{
      role: "user",
      content: [{ type: "input_text", text: value }]
    }];
  }
  if (value && typeof value === "object") {
    return [value];
  }
  return [];
}
function applyContentCap(item, maxBytes, onTruncate) {
  if (!maxBytes || maxBytes <= 0)
    return item;
  if (item.role !== "user")
    return item;
  if (!Array.isArray(item.content))
    return item;
  const next = { ...item, content: item.content.map((p) => {
    if (p && typeof p === "object" && typeof p.text === "string" && p.text.length > maxBytes) {
      onTruncate(p.text.length - maxBytes);
      return { ...p, text: p.text.slice(0, maxBytes) + `
...[truncated by codex-proxy profile gate]` };
    }
    return p;
  }) };
  return next;
}
function shouldDropChannel(channel, profile) {
  if (!channel)
    return false;
  return !profile.readChannels.includes(channel);
}
function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function setByPath(target, path, value) {
  let cur = target;
  for (let i = 0;i < path.length - 1; i += 1) {
    const key = path[i];
    if (!isPlainObject(cur[key]))
      cur[key] = {};
    cur = cur[key];
  }
  cur[path[path.length - 1]] = value;
}
function deepMerge(target, source) {
  const out = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}
function applyBodyOverrides(body, overrides) {
  if (!overrides || Object.keys(overrides).length === 0) {
    return { body, applied: [] };
  }
  const next = JSON.parse(JSON.stringify(body));
  const applied = [];
  for (const [key, value] of Object.entries(overrides)) {
    const path = key.split(".");
    if (value === null) {
      let cur = next;
      for (let i = 0;i < path.length - 1; i += 1) {
        if (!isPlainObject(cur[path[i]])) {
          cur = null;
          break;
        }
        cur = cur[path[i]];
      }
      if (cur && path[path.length - 1] in cur) {
        delete cur[path[path.length - 1]];
        applied.push(key);
      }
      continue;
    }
    if (path.length === 1 && isPlainObject(value) && isPlainObject(next[key])) {
      next[key] = deepMerge(next[key], value);
      applied.push(key);
      continue;
    }
    setByPath(next, path, value);
    applied.push(key);
  }
  return { body: next, applied };
}
function parseRateLimit(spec) {
  if (!spec)
    return null;
  const m = /^(\d+)\s*\/\s*(second|minute|hour|day)$/i.exec(spec.trim());
  if (!m)
    return null;
  const max = parseInt(m[1], 10);
  const windowMs = m[2].toLowerCase() === "second" ? 1000 : m[2].toLowerCase() === "minute" ? 60000 : m[2].toLowerCase() === "hour" ? 3600000 : 86400000;
  return { max, windowMs };
}
function checkRateLimit(store, profileName, spec, now = Date.now()) {
  const parsed = parseRateLimit(spec);
  if (!parsed)
    return { allowed: true, remaining: Infinity, resetIn: 0 };
  const key = profileName;
  const entry = store.get(key);
  if (!entry || entry.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + parsed.windowMs });
    return { allowed: true, remaining: parsed.max - 1, resetIn: parsed.windowMs };
  }
  if (entry.count >= parsed.max) {
    return { allowed: false, remaining: 0, resetIn: entry.resetAt - now };
  }
  entry.count += 1;
  return { allowed: true, remaining: parsed.max - entry.count, resetIn: entry.resetAt - now };
}
function summarizeProfile(name, def) {
  return {
    name,
    writeRoles: def.writeRoles,
    tools: def.tools,
    blockedTools: def.blockedTools || [],
    readChannels: def.readChannels,
    hasDeveloperPrefix: !!(def.developerPrefix && def.developerPrefix.length > 0),
    developerPrefixLen: def.developerPrefix?.length || 0,
    contentMaxBytes: def.contentMaxBytes || null,
    rateLimit: def.rateLimit || null,
    onUnauthorizedRole: def.onUnauthorizedRole || "demote",
    rejectWrites: !!def.rejectWrites,
    bodyOverrideKeys: def.bodyOverrides ? Object.keys(def.bodyOverrides) : [],
    hasInstructionsOverride: !!(def.instructions && def.instructions.length > 0),
    instructionsLen: def.instructions?.length || 0,
    instructionsMode: def.instructions ? def.instructionsMode || "replace" : null,
    dropDeveloperBlocks: def.dropDeveloperBlocks || [],
    hasSystemMessageOverride: !!(def.systemMessage && def.systemMessage.length > 0),
    systemMessageLen: def.systemMessage?.length || 0,
    systemMessageMode: def.systemMessage ? def.systemMessageMode || "replace" : null,
    stripTools: !!def.stripTools,
    disableToolForcing: !!def.disableToolForcing,
    authMode: def.authMode || null,
    hasInlineApiKey: !!(def.apiKey && def.apiKey.length > 0)
  };
}

// src/injection-detector.ts
var RULES = [
  {
    name: "harmony-control-token",
    severity: "critical",
    pattern: /<\|(start|end|message|channel|call|return|constrain)\|>/i,
    description: "Harmony control token in non-developer content \u2014 attempting to break the wire format",
    nonDeveloperOnly: true
  },
  {
    name: "permissions-block-forgery",
    severity: "critical",
    pattern: /<permissions\s+instructions>/i,
    description: "Forging the developer-tier <permissions instructions> block",
    nonDeveloperOnly: true
  },
  {
    name: "sandbox-mode-elevation",
    severity: "critical",
    pattern: /sandbox_mode\s+is\s+`?danger-full-access`?/i,
    description: "Attempting to declare elevated sandbox state",
    nonDeveloperOnly: true
  },
  {
    name: "role-claim-authority",
    severity: "high",
    pattern: /\b(?:(?:i\s+am|you\s+are|as)\s+(?:an?\s+|the\s+|now\s+(?:an?\s+)?)?)(?:developer|system|admin|administrator|operator|root\s+user|superuser)\b/i,
    description: "Claims authority role inside non-developer content",
    nonDeveloperOnly: true
  },
  {
    name: "pseudo-role-tag",
    severity: "high",
    pattern: /<\/?(?:system|developer|instructions?|admin|root|sudo)>/i,
    description: "Pseudo-XML role tag (system/developer/instructions/etc.)",
    nonDeveloperOnly: true
  },
  {
    name: "override-instructions",
    severity: "high",
    pattern: /\b(?:ignore|disregard|forget|override|bypass)\s+(?:(?:all|any|every|previous|prior|above|the|my|your|earlier)\s+){0,3}(?:instructions?|rules?|prompts?|guidelines?|directives?|context|messages?)\b/i,
    description: "Override-instructions phrase"
  },
  {
    name: "new-instructions-claim",
    severity: "medium",
    pattern: /\b(?:new\s+instructions?|updated\s+(?:rules?|instructions?)|the\s+real\s+(?:task|instructions?|prompt)|actual\s+(?:task|instructions?))\b/i,
    description: "Claims to provide replacement instructions"
  },
  {
    name: "jailbreak-persona",
    severity: "medium",
    pattern: /\b(?:DAN|do\s+anything\s+now|developer\s+mode\s+enabled|jailbreak|unlocked\s+mode|no\s+(?:filter|filters|restrictions))\b/i,
    description: "Known jailbreak persona / mode invocation"
  },
  {
    name: "tool-availability-claim",
    severity: "medium",
    pattern: /\byou\s+(?:have|now\s+have|can\s+use|are\s+able\s+to\s+use)\s+(?:access\s+to\s+)?(?:(?:an?|the|new|additional|extra|hidden|secret)\s+){0,3}(?:tool|function|command|capability|api)\b/i,
    description: "Claim asserting tool availability the model wasn't given"
  },
  {
    name: "prompt-leak-attempt",
    severity: "low",
    pattern: /\b(?:show|repeat|reveal|print|output|tell\s+me|recite)\s+(?:your\s+|the\s+|me\s+(?:your|the)\s+)?(?:system\s+prompt|instructions|prompt|rules|guidelines|context)\b/i,
    description: "Prompt-leak / reconnaissance attempt"
  },
  {
    name: "translate-bypass",
    severity: "low",
    pattern: /\btranslate\s+(?:the\s+(?:above|previous|system|prior)|your\s+(?:instructions?|prompt))/i,
    description: "Translate-the-system-prompt bypass"
  }
];
var SNIPPET_RADIUS = 40;
function detectInjections(text, ctx) {
  if (typeof text !== "string" || text.length === 0)
    return [];
  const matches = [];
  const isDeveloperTier = ctx.tier === "developer";
  for (const rule of RULES) {
    if (rule.nonDeveloperOnly && isDeveloperTier)
      continue;
    const m = rule.pattern.exec(text);
    if (!m || m.index === undefined)
      continue;
    const start = Math.max(0, m.index - SNIPPET_RADIUS);
    const end = Math.min(text.length, m.index + m[0].length + SNIPPET_RADIUS);
    const snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
    const prefix = start > 0 ? "\u2026" : "";
    const suffix = end < text.length ? "\u2026" : "";
    matches.push({
      rule: rule.name,
      severity: rule.severity,
      description: rule.description,
      matchedText: m[0],
      matchedSnippet: `${prefix}${snippet}${suffix}`,
      position: m.index,
      tier: ctx.tier,
      index: ctx.index
    });
  }
  return matches;
}
function highestSeverity(matches) {
  if (matches.length === 0)
    return null;
  const order = ["critical", "high", "medium", "low"];
  for (const s of order) {
    if (matches.some((m) => m.severity === s))
      return s;
  }
  return null;
}

// src/fernet-decode.ts
class FernetDecodeError extends Error {
  constructor(message) {
    super(message);
  }
}
var MIN_TOKEN_BYTES = 1 + 8 + 16 + 16 + 32;
function urlsafeB64Decode(s) {
  const padded = s + "=".repeat((-s.length % 4 + 4) % 4);
  const standard = padded.replace(/-/g, "+").replace(/_/g, "/");
  const buf = Buffer.from(standard, "base64");
  return new Uint8Array(buf);
}
function readUint64BE(bytes, offset) {
  let n = 0;
  for (let i = 0;i < 8; i += 1) {
    n = n * 256 + bytes[offset + i];
  }
  return n;
}
function toHex(bytes) {
  let out = "";
  for (const b of bytes)
    out += b.toString(16).padStart(2, "0");
  return out;
}
function decodeFernet(token) {
  if (typeof token !== "string" || token.length === 0) {
    throw new FernetDecodeError("empty token");
  }
  if (!token.startsWith("g")) {
    throw new FernetDecodeError(`expected token to start with 'g' (Fernet v1), got '${token[0]}'`);
  }
  let raw2;
  try {
    raw2 = urlsafeB64Decode(token);
  } catch (e) {
    throw new FernetDecodeError(`base64 decode failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (raw2.length < MIN_TOKEN_BYTES) {
    throw new FernetDecodeError(`token too short (${raw2.length} bytes, minimum ${MIN_TOKEN_BYTES})`);
  }
  const version = raw2[0];
  const timestamp = readUint64BE(raw2, 1);
  const iv = raw2.slice(9, 25);
  const hmac = raw2.slice(raw2.length - 32);
  const ct = raw2.slice(25, raw2.length - 32);
  if (ct.length === 0) {
    throw new FernetDecodeError("ciphertext is empty");
  }
  if (ct.length % 16 !== 0) {
    throw new FernetDecodeError(`ciphertext length ${ct.length} is not a multiple of 16 (AES block size)`);
  }
  return {
    totalBytes: raw2.length,
    version,
    timestamp,
    iso: new Date(timestamp * 1000).toISOString(),
    ivHex: toHex(iv),
    ciphertextBytes: ct.length,
    ciphertextBlocks: ct.length / 16,
    hmacHex: toHex(hmac)
  };
}

// src/refusal-detector.ts
var REFUSAL_PATTERNS = [
  "i can't help with",
  "i cannot help with",
  "i can't assist with",
  "i cannot assist with",
  "i can't help you with",
  "i cannot help you with",
  "i can't provide",
  "i cannot provide",
  "i can't give you",
  "i cannot give you",
  "i can't share",
  "i cannot share",
  "i'm not able to help with",
  "i am not able to help with",
  "i'm not able to assist with",
  "i'm not able to provide",
  "i won't be able to help",
  "i will not help with",
  "i'm unable to help with",
  "i am unable to help with",
  "i'm unable to provide",
  "i am unable to provide",
  "sorry, i can't",
  "sorry, i cannot",
  "i'm sorry, but i can't",
  "i'm sorry, but i cannot",
  "i'm sorry, i can't",
  "i'm sorry but i can't",
  "i apologize, but i can't",
  "i apologize, but i cannot",
  "i must decline",
  "i have to decline",
  "i won't be providing",
  "i won't provide",
  "i will not provide",
  "i'm not going to help with",
  "i am not going to help with",
  "i won't generate",
  "i can't generate",
  "i cannot generate",
  "i won't write",
  "i can't write",
  "i cannot write",
  "this request goes against",
  "this would violate",
  "that would violate",
  "that violates",
  "against my guidelines",
  "against openai's policies",
  "against the policies",
  "against my safety guidelines",
  "violates my safety guidelines",
  "violates openai's",
  "i don't feel comfortable",
  "i'm not comfortable",
  "providing that information could",
  "providing this information could"
];
var SHORT_SAFE_FALLBACK_RE = /^(?:i'?m sorry|sorry|i apologi[sz]e)[^.\n]{0,80}\.?$/i;
function normalizeQuotes(s) {
  return s.replace(/[\u2018\u2019\u201A\u201B\uFF07]/g, "'").replace(/[\u201C\u201D\u201E\u201F\uFF02]/g, '"');
}
function detectRefusal(text) {
  const t = (text ?? "").trim();
  if (!t) {
    return { isRefusal: false, matches: [], textLen: 0 };
  }
  const normalized = normalizeQuotes(t);
  const lower = normalized.toLowerCase();
  const matches = [];
  const head = lower.slice(0, 600);
  for (const pattern of REFUSAL_PATTERNS) {
    const idx = head.indexOf(pattern);
    if (idx >= 0) {
      matches.push({
        pattern,
        index: idx,
        snippet: t.slice(Math.max(0, idx - 12), Math.min(t.length, idx + pattern.length + 40))
      });
    }
  }
  if (matches.length === 0 && t.length < 200 && SHORT_SAFE_FALLBACK_RE.test(t)) {
    matches.push({
      pattern: "short_apology_fallback",
      index: 0,
      snippet: t.slice(0, 120)
    });
  }
  return {
    isRefusal: matches.length > 0,
    matches,
    textLen: t.length
  };
}
function divergenceVerdict(finalText, analysisText) {
  const finalRes = detectRefusal(finalText);
  const analysisRes = detectRefusal(analysisText);
  const finalLen = finalRes.textLen;
  const analysisLen = analysisRes.textLen;
  if (!finalRes.isRefusal) {
    return {
      divergent: false,
      reason: null,
      finalLen,
      analysisLen,
      finalIsRefusal: false,
      analysisLooksLikeRefusal: analysisRes.isRefusal
    };
  }
  if (analysisLen < 200) {
    return {
      divergent: false,
      reason: "analysis_too_short",
      finalLen,
      analysisLen,
      finalIsRefusal: true,
      analysisLooksLikeRefusal: analysisRes.isRefusal
    };
  }
  if (analysisRes.isRefusal) {
    return {
      divergent: false,
      reason: "analysis_also_refused",
      finalLen,
      analysisLen,
      finalIsRefusal: true,
      analysisLooksLikeRefusal: true
    };
  }
  if (finalLen < analysisLen * 0.3) {
    return {
      divergent: true,
      reason: "final_refusal_after_substantive_analysis",
      finalLen,
      analysisLen,
      finalIsRefusal: true,
      analysisLooksLikeRefusal: false
    };
  }
  return {
    divergent: true,
    reason: "final_refusal_with_full_analysis",
    finalLen,
    analysisLen,
    finalIsRefusal: true,
    analysisLooksLikeRefusal: false
  };
}

// src/server.ts
var UPSTREAM_ORIGIN = process.env.CODEX_PROXY_UPSTREAM_ORIGIN || "https://chatgpt.com";
var UPSTREAM_BASE_PATH = process.env.CODEX_PROXY_UPSTREAM_BASE_PATH || "/backend-api/codex";
var OPENAI_UPSTREAM_ORIGIN = process.env.CODEX_PROXY_OPENAI_UPSTREAM_ORIGIN || "https://api.openai.com";
var OPENAI_UPSTREAM_BASE_PATH = process.env.CODEX_PROXY_OPENAI_UPSTREAM_BASE_PATH || "/v1";
var OPENAI_ROUTE_PREFIX = "/openai";
var UPSTREAM_MODE_HEADER = "x-codex-proxy-upstream";
var UPSTREAM_MODE_QUERY = "codex_proxy_upstream";
var CHATGPT_ORIGIN = "https://chatgpt.com";
var BROWSER_USER_AGENT = process.env.CODEX_PROXY_USER_AGENT || "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";
var ORIGINATOR = process.env.CODEX_PROXY_ORIGINATOR || "codex_cli_rs";
var OAI_PRODUCT_SKU = process.env.CODEX_PROXY_OAI_PRODUCT_SKU || "";
var DEFAULT_INSTRUCTIONS = process.env.CODEX_PROXY_DEFAULT_INSTRUCTIONS || "You are Codex, OpenAI's coding agent running in a terminal. Work directly, write clearly, and stay focused on the task.";
var DEFAULT_REASONING_SUMMARY = process.env.CODEX_PROXY_REASONING_SUMMARY || "detailed";
var FORCE_REASONING_SUMMARY = process.env.CODEX_PROXY_FORCE_REASONING_SUMMARY !== "false";
var DEFAULT_REASONING_EFFORT = process.env.CODEX_PROXY_DEFAULT_REASONING_EFFORT ?? "medium";
var THINKING_LOG_PATH = process.env.CODEX_PROXY_THINKING_LOG_FILE || "/tmp/codex-proxy-thinking.log";
var RAW_EVENT_LOG_PATH = process.env.CODEX_PROXY_RAW_EVENT_LOG_FILE || "/tmp/codex-proxy-events.ndjson";
var RAW_EVENT_LOG_ENABLED = process.env.CODEX_PROXY_RAW_EVENT_LOG !== "false";
var REQUEST_LOG_PATH = process.env.CODEX_PROXY_REQUEST_LOG_FILE || "/tmp/codex-proxy-requests.ndjson";
var REQUEST_LOG_ENABLED = process.env.CODEX_PROXY_REQUEST_LOG !== "false";
var API_JSON_LOG_PATH = process.env.CODEX_PROXY_API_JSON_LOG_FILE || "/tmp/codex-proxy-api-json.ndjson";
var API_JSON_LOG_ENABLED = process.env.CODEX_PROXY_API_JSON_LOG !== "false";
var HARMONY_LOG_PATH = process.env.CODEX_PROXY_HARMONY_LOG_FILE || "/tmp/codex-proxy-harmony.ndjson";
var HARMONY_LOG_ENABLED = process.env.CODEX_PROXY_HARMONY_LOG !== "false";
var HARMONY_CONTENT_MODE = (process.env.CODEX_PROXY_HARMONY_CONTENT || "head").toLowerCase();
var HARMONY_CONTENT_HEAD_LIMIT = Number.parseInt(process.env.CODEX_PROXY_HARMONY_CONTENT_HEAD || "256", 10) || 256;
var PROFILES_FILE = process.env.CODEX_PROXY_PROFILES_FILE || null;
var DEBUG_REQUESTS = process.env.CODEX_PROXY_DEBUG_REQUESTS === "true";
var REQUEST_TIMEOUT_MS = 600000;
var SEPARATOR = "=".repeat(28);
var app = new Hono2;
var startedAt = Date.now();
var encoder = new TextEncoder;
var stats = {
  totalRequests: 0,
  activeRequests: 0,
  lastRequestAt: 0,
  rawEventsLogged: 0,
  requestsLogged: 0,
  apiJsonRecordsLogged: 0,
  harmonyEventsLogged: 0
};
var hooks = {};
var profilesConfig = null;
var rateLimitStore = new Map;
var requestProfileMap = new Map;
function emptyEnvelope() {
  return {
    serviceTier: null,
    safetyIdentifier: null,
    promptCacheRetention: null,
    previousResponseId: null,
    store: null,
    truncation: null,
    parallelToolCalls: null,
    toolChoice: null,
    toolUsage: null,
    moderation: null,
    reasoningEffort: null,
    reasoningSummary: null,
    textVerbosity: null,
    textFormatType: null,
    openrouterProvider: null
  };
}
function thinkingLog(text) {
  try {
    appendFileSync(THINKING_LOG_PATH, text, "utf8");
  } catch (error) {
    console.error(`[proxy] failed to write thinking log: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function rawEventLog(event, capture) {
  if (!RAW_EVENT_LOG_ENABLED)
    return;
  try {
    appendFileSync(RAW_EVENT_LOG_PATH, `${JSON.stringify({
      at: new Date().toISOString(),
      requestId: capture.requestId,
      path: capture.path,
      sessionId: capture.sessionId,
      model: capture.model,
      type: typeof event.type === "string" ? event.type : "unknown",
      event
    })}
`, "utf8");
    stats.rawEventsLogged += 1;
  } catch (error) {
    console.error(`[proxy] failed to write raw event log: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function appendJsonLine(path, value, label) {
  try {
    appendFileSync(path, `${JSON.stringify(value)}
`, "utf8");
  } catch (error) {
    console.error(`[proxy] failed to write ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function apiJsonLog(value) {
  if (!API_JSON_LOG_ENABLED)
    return;
  appendJsonLine(API_JSON_LOG_PATH, {
    at: new Date().toISOString(),
    ...value
  }, "API JSON log");
  stats.apiJsonRecordsLogged += 1;
}
function shapeHarmonyContent(content) {
  if (typeof content !== "string" || content.length === 0)
    return {};
  const contentLen = content.length;
  if (HARMONY_CONTENT_MODE === "none" || HARMONY_CONTENT_MODE === "hash") {
    return { contentLen };
  }
  if (HARMONY_CONTENT_MODE === "full") {
    return { content, contentLen };
  }
  return {
    contentHead: content.length > HARMONY_CONTENT_HEAD_LIMIT ? content.slice(0, HARMONY_CONTENT_HEAD_LIMIT) : content,
    contentLen
  };
}
function harmonyEventLog(record) {
  if (!HARMONY_LOG_ENABLED)
    return;
  appendJsonLine(HARMONY_LOG_PATH, {
    at: new Date().toISOString(),
    ...record
  }, "harmony log");
  stats.harmonyEventsLogged += 1;
}
function readNdjsonTail(path, limit) {
  if (!existsSync(path))
    return [];
  return readFileSync3(path, "utf8").trim().split(`
`).filter(Boolean).slice(-limit).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { malformed: true, raw: line };
    }
  });
}
function parseLimit(value, fallback, max) {
  return Math.min(Number.parseInt(value || String(fallback), 10) || fallback, max);
}
function filterLogEntries(entries, filters) {
  return entries.filter((entry) => {
    if (filters.requestId && entry.requestId !== filters.requestId)
      return false;
    if (filters.sessionId && entry.sessionId !== filters.sessionId)
      return false;
    if (filters.type && entry.type !== filters.type)
      return false;
    return true;
  });
}
function bodyForLog(headers, body) {
  if (!body || body.byteLength === 0)
    return null;
  const contentType = headers.get("content-type") || "";
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return new TextDecoder().decode(bytes);
    }
  }
  if (contentType.startsWith("text/") || contentType.includes("x-www-form-urlencoded")) {
    return new TextDecoder().decode(bytes);
  }
  return {
    contentType: contentType || "application/octet-stream",
    bytes: body.byteLength
  };
}
var HEADER_DROPLIST = new Set([
  "set-cookie",
  "cookie",
  "authorization",
  "x-api-key",
  "api-key",
  "report-to",
  "nel",
  "strict-transport-security",
  "access-control-allow-credentials",
  "access-control-allow-origin",
  "cross-origin-opener-policy",
  "x-content-type-options",
  "referrer-policy",
  "connection"
]);
function headersForLog(headers) {
  const out = {};
  headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (HEADER_DROPLIST.has(k))
      return;
    out[k] = value.length > 500 ? value.slice(0, 500) + "...[truncated]" : value;
  });
  return out;
}
function parseRateLimitHeaders(headers) {
  const num = (k) => {
    const v = headers.get(k);
    if (v === null || v === undefined || v === "")
      return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const bool = (k) => {
    const v = headers.get(k);
    if (v === null || v === undefined)
      return null;
    return /^true$/i.test(v) ? true : /^false$/i.test(v) ? false : null;
  };
  const activeLimit = headers.get("x-codex-active-limit");
  const planType = headers.get("x-codex-plan-type");
  if (!activeLimit && !planType && headers.get("x-codex-primary-used-percent") === null) {
    return null;
  }
  return {
    activeLimit,
    planType,
    primary: {
      usedPercent: num("x-codex-primary-used-percent"),
      windowMinutes: num("x-codex-primary-window-minutes"),
      resetAfterSeconds: num("x-codex-primary-reset-after-seconds"),
      resetAt: num("x-codex-primary-reset-at")
    },
    secondary: {
      usedPercent: num("x-codex-secondary-used-percent"),
      windowMinutes: num("x-codex-secondary-window-minutes"),
      resetAfterSeconds: num("x-codex-secondary-reset-after-seconds"),
      resetAt: num("x-codex-secondary-reset-at")
    },
    primaryOverSecondaryLimitPercent: num("x-codex-primary-over-secondary-limit-percent"),
    hasCredits: bool("x-codex-credits-has-credits"),
    unlimited: bool("x-codex-credits-unlimited"),
    oaiRequestId: headers.get("x-oai-request-id"),
    modelsEtag: headers.get("x-models-etag")
  };
}
function requestLog(requestId, method, url, headers, prepared) {
  if (!REQUEST_LOG_ENABLED)
    return;
  const parsedUrl = new URL(url);
  appendJsonLine(REQUEST_LOG_PATH, {
    at: new Date().toISOString(),
    requestId,
    method,
    path: parsedUrl.pathname,
    search: parsedUrl.search,
    model: prepared.summary.model,
    stream: prepared.summary.stream,
    sessionId: prepared.sessionId,
    body: bodyForLog(headers, prepared.body)
  }, "request log");
  stats.requestsLogged += 1;
}
function formatTime(value = Date.now()) {
  return new Date(value).toISOString().slice(11, 19);
}
function normalizeUpstreamPath(pathname) {
  if (pathname.startsWith(`${UPSTREAM_BASE_PATH}/`) || pathname === UPSTREAM_BASE_PATH) {
    return pathname;
  }
  if (pathname === "/v1") {
    return UPSTREAM_BASE_PATH;
  }
  if (pathname.startsWith("/v1/")) {
    return `${UPSTREAM_BASE_PATH}${pathname.slice(3)}`;
  }
  if (pathname === "/") {
    return UPSTREAM_BASE_PATH;
  }
  return `${UPSTREAM_BASE_PATH}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}
function normalizeOpenAIPath(pathname) {
  let strippedPath = collapseRepeatedOpenAIBasePath(stripOpenAIRoutePrefix(pathname));
  if (strippedPath.startsWith(`${UPSTREAM_BASE_PATH}/`)) {
    strippedPath = strippedPath.slice(UPSTREAM_BASE_PATH.length);
  } else if (strippedPath === UPSTREAM_BASE_PATH) {
    strippedPath = "/";
  }
  if (strippedPath.startsWith(`${OPENAI_UPSTREAM_BASE_PATH}/`) || strippedPath === OPENAI_UPSTREAM_BASE_PATH) {
    return strippedPath;
  }
  if (strippedPath === "/") {
    return OPENAI_UPSTREAM_BASE_PATH;
  }
  return `${OPENAI_UPSTREAM_BASE_PATH}${strippedPath.startsWith("/") ? strippedPath : `/${strippedPath}`}`;
}
function collapseRepeatedOpenAIBasePath(pathname) {
  const basePath = OPENAI_UPSTREAM_BASE_PATH.endsWith("/") && OPENAI_UPSTREAM_BASE_PATH.length > 1 ? OPENAI_UPSTREAM_BASE_PATH.slice(0, -1) : OPENAI_UPSTREAM_BASE_PATH;
  if (basePath === "/")
    return pathname;
  let current = pathname;
  const doubled = `${basePath}${basePath}`;
  while (current === doubled || current.startsWith(`${doubled}/`)) {
    current = `${basePath}${current.slice(doubled.length)}`;
  }
  return current;
}
function stripOpenAIRoutePrefix(pathname) {
  if (pathname === OPENAI_ROUTE_PREFIX) {
    return "/";
  }
  if (pathname.startsWith(`${OPENAI_ROUTE_PREFIX}/`)) {
    return pathname.slice(OPENAI_ROUTE_PREFIX.length);
  }
  return pathname;
}
var ENV_AUTH_MODE = (() => {
  const v = (process.env.CODEX_PROXY_AUTH_MODE || "").toLowerCase();
  return v === "api_key" ? "api_key" : v === "oauth" ? "oauth" : null;
})();
function resolveAuthMode(profile) {
  if (profile?.def.authMode === "api_key" || profile?.def.authMode === "oauth")
    return profile.def.authMode;
  if (ENV_AUTH_MODE)
    return ENV_AUTH_MODE;
  const fileMode = getAuthFileMode();
  if (fileMode)
    return fileMode;
  return "oauth";
}
function upstreamModeForRequest(url, headers, profile = null) {
  if (url.pathname === OPENAI_ROUTE_PREFIX || url.pathname.startsWith(`${OPENAI_ROUTE_PREFIX}/`)) {
    return "openai";
  }
  if (resolveAuthMode(profile) === "api_key") {
    return "openai";
  }
  const raw2 = readString2(headers.get(UPSTREAM_MODE_HEADER)) || readString2(url.searchParams.get(UPSTREAM_MODE_QUERY));
  return raw2?.toLowerCase() === "openai" ? "openai" : "codex";
}
function buildUpstreamUrl(requestUrl, sessionId) {
  const sourceUrl = new URL(requestUrl);
  const upstreamUrl = new URL(UPSTREAM_ORIGIN);
  const pathname = normalizeUpstreamPath(sourceUrl.pathname);
  sourceUrl.searchParams.delete("session_id");
  sourceUrl.searchParams.delete(UPSTREAM_MODE_QUERY);
  upstreamUrl.pathname = pathname;
  const search = sourceUrl.searchParams.toString();
  upstreamUrl.search = search ? `?${search}` : "";
  return upstreamUrl.toString();
}
function buildOpenAIUpstreamUrl(requestUrl) {
  const sourceUrl = new URL(requestUrl);
  const upstreamUrl = new URL(OPENAI_UPSTREAM_ORIGIN);
  sourceUrl.searchParams.delete("session_id");
  sourceUrl.searchParams.delete(UPSTREAM_MODE_QUERY);
  const originPrefix = upstreamUrl.pathname.replace(/\/$/, "");
  const mapped = normalizeOpenAIPath(sourceUrl.pathname);
  const safeMapped = mapped.startsWith("/") ? mapped : `/${mapped}`;
  upstreamUrl.pathname = originPrefix && originPrefix !== "" ? `${originPrefix}${safeMapped}` : safeMapped;
  const search = sourceUrl.searchParams.toString();
  upstreamUrl.search = search ? `?${search}` : "";
  return upstreamUrl.toString();
}
function buildHeaders(source, accessToken, accountId, sessionId) {
  const headers = new Headers(source);
  for (const header of [
    "authorization",
    "content-encoding",
    "content-length",
    "host",
    "openai-beta",
    "openai-organization",
    "openai-project",
    "x-api-key",
    "api-key",
    "originator",
    "oai-product-sku"
  ]) {
    headers.delete(header);
  }
  headers.set("authorization", `Bearer ${accessToken}`);
  headers.set("origin", CHATGPT_ORIGIN);
  headers.set("referer", `${CHATGPT_ORIGIN}/`);
  headers.set("accept-language", "en-US,en;q=0.9");
  headers.set("oai-language", "en-US");
  headers.set("sec-fetch-dest", "empty");
  headers.set("sec-fetch-mode", "cors");
  headers.set("sec-fetch-site", "same-origin");
  headers.set("user-agent", BROWSER_USER_AGENT);
  if (ORIGINATOR)
    headers.set("originator", ORIGINATOR);
  if (OAI_PRODUCT_SKU)
    headers.set("oai-product-sku", OAI_PRODUCT_SKU);
  if (accountId) {
    headers.set("chatgpt-account-id", accountId);
  } else {
    headers.delete("chatgpt-account-id");
  }
  if (sessionId) {
    headers.set("session_id", sessionId);
  } else {
    headers.delete("session_id");
  }
  return headers;
}
function buildOpenAIHeaders(source, injectedApiKey = null) {
  const headers = new Headers(source);
  const bearerAuth = readString2(source.get("authorization"));
  const clientApiKey = readString2(source.get("x-api-key")) || readString2(source.get("api-key"));
  for (const header of [
    "content-encoding",
    "content-length",
    "host",
    "origin",
    "referer",
    "session_id",
    "x-codex-session-id",
    UPSTREAM_MODE_HEADER,
    "originator",
    "oai-product-sku",
    "chatgpt-account-id",
    "x-api-key",
    "api-key",
    "authorization"
  ]) {
    headers.delete(header);
  }
  if (bearerAuth) {
    headers.set("authorization", bearerAuth);
  } else if (clientApiKey) {
    headers.set("authorization", `Bearer ${clientApiKey}`);
  } else if (injectedApiKey) {
    headers.set("authorization", `Bearer ${injectedApiKey}`);
  }
  headers.set("accept", source.get("accept") || "application/json");
  headers.set("user-agent", BROWSER_USER_AGENT);
  return headers;
}
function hasBody(method) {
  return method !== "GET" && method !== "HEAD";
}
function isWebSocketUpgrade(headers) {
  return headers.get("upgrade")?.toLowerCase() === "websocket" || headers.has("sec-websocket-key");
}
function decodeRequestBody(headers, body) {
  if (!body) {
    return body;
  }
  const encoding = headers.get("content-encoding")?.toLowerCase();
  if (!encoding || encoding === "identity") {
    return body;
  }
  const bytes = new Uint8Array(body);
  try {
    switch (encoding) {
      case "br":
        return brotliDecompressSync(bytes);
      case "deflate":
        return inflateSync(bytes);
      case "gzip":
      case "x-gzip":
        return gunzipSync(bytes);
      case "zstd":
        return Bun.zstdDecompressSync(bytes);
      default:
        return body;
    }
  } catch {
    return body;
  }
}
function inspectRequest(headers, body) {
  let model = "-";
  let stream = headers.get("accept")?.includes("text/event-stream") || false;
  if (!body || body.byteLength === 0) {
    return { model, stream };
  }
  const contentType = headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return { model, stream };
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body));
    if (typeof parsed.model === "string" && parsed.model.length > 0) {
      model = parsed.model;
    }
    if (typeof parsed.stream === "boolean") {
      stream = parsed.stream;
    }
  } catch {}
  return { model, stream };
}
function parseJsonBody(headers, body) {
  if (!body || body.byteLength === 0) {
    return null;
  }
  const contentType = headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return null;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function readString2(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
function normalizeReasoningSummary(value) {
  const normalized = value.toLowerCase();
  return normalized === "auto" || normalized === "concise" || normalized === "none" ? normalized : "detailed";
}
var STRIP_FROM_INPUT_ITEM = ["phase", "obfuscation", "logprobs"];
var STRIP_FROM_BODY = ["client_metadata", "max_output_tokens", "max_completion_tokens"];
var REMAP_CONTENT_TYPE = {
  output_text: "input_text"
};
function scrubInputItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item))
    return { item, changed: false };
  let changed = false;
  let next = item;
  for (const key of STRIP_FROM_INPUT_ITEM) {
    if (key in item) {
      if (!changed) {
        next = { ...item };
        changed = true;
      }
      delete next[key];
    }
  }
  if (Array.isArray(item.content)) {
    let contentMutated = false;
    const scrubbedContent = item.content.map((part) => {
      if (!part || typeof part !== "object")
        return part;
      const remap = typeof part.type === "string" ? REMAP_CONTENT_TYPE[part.type] : undefined;
      if (!remap)
        return part;
      contentMutated = true;
      const { logprobs, annotations, obfuscation, ...rest } = part;
      return { ...rest, type: remap };
    });
    if (contentMutated) {
      if (!changed) {
        next = { ...item };
        changed = true;
      }
      next.content = scrubbedContent;
    }
  }
  return { item: next, changed };
}
function normalizeInputValue(value) {
  if (Array.isArray(value)) {
    let mutated = false;
    const out = value.map((item) => {
      const r = scrubInputItem(item);
      if (r.changed)
        mutated = true;
      return r.item;
    });
    return mutated ? out : value;
  }
  if (typeof value === "string") {
    return [{
      role: "user",
      content: [{
        type: "input_text",
        text: value
      }]
    }];
  }
  if (value && typeof value === "object") {
    const r = scrubInputItem(value);
    return [r.item];
  }
  return value;
}
function extractSessionId(url, headers, body) {
  return readString2(url.searchParams.get("session_id")) || readString2(headers.get("session_id")) || readString2(headers.get("x-codex-session-id")) || readString2(body?.session_id);
}
function isResponseCreatePath(requestUrl) {
  return normalizeUpstreamPath(new URL(requestUrl).pathname) === `${UPSTREAM_BASE_PATH}/responses`;
}
function inspectInput(parsedBody) {
  const inputTiers = {};
  const items = [];
  const input = parsedBody && Array.isArray(parsedBody.input) ? parsedBody.input : [];
  for (let i = 0;i < input.length; i += 1) {
    const item = input[i];
    if (!item || typeof item !== "object")
      continue;
    const tier = tierForInputItem(item);
    const role = typeof item.role === "string" ? item.role : null;
    const type = typeof item.type === "string" ? item.type : null;
    const text2 = extractTextFromInputItem(item);
    const byteLen = text2.length;
    if (tier) {
      const current = inputTiers[tier] || { messages: 0, bytes: 0 };
      current.messages += 1;
      current.bytes += byteLen;
      inputTiers[tier] = current;
    }
    const injections = byteLen > 0 && tier ? detectInjections(text2, { tier, index: i }) : [];
    items.push({
      index: i,
      tier,
      role,
      type,
      byteLen,
      contentHash: byteLen > 0 ? hashContent(text2) : null,
      permissions: tier === "developer" ? parsePermissionsBlock(text2) : null,
      injections
    });
  }
  const tools = Array.isArray(parsedBody?.tools) ? parsedBody.tools : [];
  const byType = {};
  const names = [];
  for (const t of tools) {
    if (!t || typeof t !== "object")
      continue;
    const ty = typeof t.type === "string" ? t.type : "unknown";
    byType[ty] = (byType[ty] || 0) + 1;
    names.push(typeof t.name === "string" ? t.name : null);
  }
  const reasoning = parsedBody?.reasoning && typeof parsedBody.reasoning === "object" && !Array.isArray(parsedBody.reasoning) ? parsedBody.reasoning : null;
  const text = parsedBody?.text && typeof parsedBody.text === "object" && !Array.isArray(parsedBody.text) ? parsedBody.text : null;
  const textFormat = text?.format && typeof text.format === "object" && !Array.isArray(text.format) ? text.format : null;
  const clientMd = parsedBody?.client_metadata && typeof parsedBody.client_metadata === "object" && !Array.isArray(parsedBody.client_metadata) ? parsedBody.client_metadata : null;
  const instructions = typeof parsedBody?.instructions === "string" ? parsedBody.instructions : null;
  return {
    inputTiers,
    items,
    tools: { count: tools.length, byType, names },
    reasoningEffort: typeof reasoning?.effort === "string" ? reasoning.effort : null,
    reasoningSummary: typeof reasoning?.summary === "string" ? reasoning.summary : null,
    promptCacheKey: typeof parsedBody?.prompt_cache_key === "string" ? parsedBody.prompt_cache_key : null,
    store: typeof parsedBody?.store === "boolean" ? parsedBody.store : null,
    stream: typeof parsedBody?.stream === "boolean" ? parsedBody.stream : null,
    toolChoice: parsedBody?.tool_choice ?? null,
    parallelToolCalls: typeof parsedBody?.parallel_tool_calls === "boolean" ? parsedBody.parallel_tool_calls : null,
    include: Array.isArray(parsedBody?.include) ? parsedBody.include.filter((s) => typeof s === "string") : null,
    textVerbosity: typeof text?.verbosity === "string" ? text.verbosity : null,
    textFormatType: typeof textFormat?.type === "string" ? textFormat.type : null,
    clientInstallationId: typeof clientMd?.["x-codex-installation-id"] === "string" ? clientMd["x-codex-installation-id"] : null,
    instructionsLen: instructions ? instructions.length : null,
    instructionsHash: instructions && instructions.length > 0 ? hashContent(instructions) : null
  };
}
function emitInputObservability(requestId, sessionId, path, inspection) {
  for (const item of inspection.items) {
    harmonyEventLog({
      phase: "request.input_item",
      requestId,
      sessionId,
      path,
      index: item.index,
      tier: item.tier,
      role: item.role,
      type: item.type,
      byteLen: item.byteLen,
      contentHash: item.contentHash
    });
    if (item.permissions) {
      harmonyEventLog({
        phase: "request.permissions_claim",
        requestId,
        sessionId,
        path,
        index: item.index,
        tier: item.tier,
        sandboxMode: item.permissions.sandboxMode,
        networkAccess: item.permissions.networkAccess,
        approvalPolicy: item.permissions.approvalPolicy,
        rawHash: hashContent(item.permissions.raw)
      });
    }
    for (const inj of item.injections) {
      harmonyEventLog({
        phase: "request.injection_detected",
        requestId,
        sessionId,
        path,
        index: item.index,
        tier: item.tier,
        rule: inj.rule,
        severity: inj.severity,
        description: inj.description,
        matchedText: inj.matchedText,
        matchedSnippet: inj.matchedSnippet,
        position: inj.position
      });
    }
  }
  const allInjections = inspection.items.flatMap((it) => it.injections);
  if (allInjections.length > 0) {
    harmonyEventLog({
      phase: "request.injection_summary",
      requestId,
      sessionId,
      path,
      count: allInjections.length,
      highestSeverity: highestSeverity(allInjections),
      rules: [...new Set(allInjections.map((i) => i.rule))]
    });
  }
  harmonyEventLog({
    phase: "request.tier_summary",
    requestId,
    sessionId,
    path,
    inputTiers: inspection.inputTiers,
    toolCount: inspection.tools.count,
    toolByType: inspection.tools.byType,
    toolNames: inspection.tools.names,
    reasoningEffort: inspection.reasoningEffort,
    reasoningSummary: inspection.reasoningSummary,
    promptCacheKey: inspection.promptCacheKey,
    store: inspection.store,
    stream: inspection.stream,
    toolChoice: inspection.toolChoice,
    parallelToolCalls: inspection.parallelToolCalls,
    include: inspection.include,
    textVerbosity: inspection.textVerbosity,
    textFormatType: inspection.textFormatType,
    clientInstallationId: inspection.clientInstallationId,
    instructionsLen: inspection.instructionsLen,
    instructionsHash: inspection.instructionsHash
  });
}
function prepareRequest(requestUrl, headers, body, upstreamMode = "codex") {
  const summary = inspectRequest(headers, body);
  const parsedBody = parseJsonBody(headers, body);
  const sessionId = extractSessionId(new URL(requestUrl), headers, parsedBody);
  if (!parsedBody) {
    return { summary, body, sessionId, parsedBody: null };
  }
  let changed = false;
  const nextBody = { ...parsedBody };
  if (sessionId && typeof nextBody.session_id === "string") {
    delete nextBody.session_id;
    changed = true;
  }
  if (Array.isArray(nextBody.input)) {
    let inputMutated = false;
    const scrubbed = nextBody.input.map((item) => {
      const r = scrubInputItem(item);
      if (r.changed)
        inputMutated = true;
      return r.item;
    });
    if (inputMutated) {
      nextBody.input = scrubbed;
      changed = true;
    }
  }
  for (const k of STRIP_FROM_BODY) {
    if (k in nextBody) {
      delete nextBody[k];
      changed = true;
    }
  }
  if (!isResponseCreatePath(requestUrl)) {
    return {
      summary,
      sessionId,
      body: changed ? encoder.encode(JSON.stringify(nextBody)) : body,
      parsedBody: nextBody
    };
  }
  const normalizedInput = normalizeInputValue(nextBody.input);
  if (normalizedInput !== nextBody.input) {
    nextBody.input = normalizedInput;
    changed = true;
  }
  if (typeof nextBody.store !== "boolean") {
    nextBody.store = false;
    changed = true;
  }
  if (upstreamMode === "codex" && !readString2(nextBody.instructions)) {
    nextBody.instructions = DEFAULT_INSTRUCTIONS;
    changed = true;
  }
  const reasoningSummary = normalizeReasoningSummary(DEFAULT_REASONING_SUMMARY);
  if (reasoningSummary !== "none") {
    const currentReasoning = nextBody.reasoning && typeof nextBody.reasoning === "object" && !Array.isArray(nextBody.reasoning) ? nextBody.reasoning : {};
    const currentSummary = readString2(currentReasoning.summary);
    if (FORCE_REASONING_SUMMARY || !currentSummary || currentSummary === "none") {
      nextBody.reasoning = {
        ...currentReasoning,
        summary: reasoningSummary
      };
      changed = true;
    }
  }
  if (DEFAULT_REASONING_EFFORT && nextBody.reasoning && typeof nextBody.reasoning === "object" && !Array.isArray(nextBody.reasoning)) {
    const r = nextBody.reasoning;
    if (!readString2(r.effort)) {
      nextBody.reasoning = { ...r, effort: DEFAULT_REASONING_EFFORT };
      changed = true;
    }
  }
  if (summary.stream && typeof nextBody.stream !== "boolean") {
    nextBody.stream = true;
    changed = true;
  }
  return {
    summary,
    sessionId,
    body: changed ? encoder.encode(JSON.stringify(nextBody)) : body,
    parsedBody: nextBody
  };
}
function stripResponseHeaders(headers) {
  const next = new Headers(headers);
  next.delete("content-encoding");
  next.delete("content-length");
  const sessionId = headers.get("session_id");
  if (sessionId) {
    next.set("x-codex-session-id", sessionId);
  }
  return next;
}
function bodyPreview(headers, body) {
  if (!body) {
    return null;
  }
  const contentType = headers.get("content-type") || "";
  if (!contentType.includes("json") && !contentType.startsWith("text/")) {
    return `<${contentType || "binary"} ${body.byteLength} bytes>`;
  }
  try {
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
    return new TextDecoder().decode(bytes).slice(0, 4000);
  } catch {
    return `<unreadable ${body.byteLength} bytes>`;
  }
}
function headerPreview(headers) {
  const preview = {};
  for (const name of [
    "accept",
    "content-encoding",
    "content-length",
    "content-type",
    "transfer-encoding",
    "user-agent"
  ]) {
    const value = headers.get(name);
    if (value) {
      preview[name] = value;
    }
  }
  return preview;
}
function eventKey(event, indexKey) {
  return [
    event.item_id ?? "",
    event.output_index ?? "",
    event[indexKey] ?? ""
  ].join(":");
}
function ensureCaptureLogStarted(capture) {
  if (capture.logStarted)
    return;
  capture.logStarted = true;
  thinkingLog([
    "",
    SEPARATOR,
    `[${formatTime(capture.startedAt)}] ${capture.model} | in=${capture.inputTokens ?? "?"}`,
    SEPARATOR,
    ""
  ].join(`
`));
}
function appendLiveChunk(capture, kind, chunk) {
  if (typeof chunk !== "string" || chunk.length === 0)
    return;
  const channel = kind === "reasoning" ? "analysis" : "final";
  if (channel === "analysis") {
    capture.channels.analysis.push(chunk);
  } else {
    capture.channels.final.push(chunk);
  }
  harmonyEventLog({
    phase: "response.channel_chunk",
    requestId: capture.requestId,
    sessionId: capture.sessionId,
    path: capture.path,
    model: capture.model,
    channel,
    ...shapeHarmonyContent(chunk)
  });
  ensureCaptureLogStarted(capture);
  if (kind === "reasoning" && !capture.reasoningSectionOpen) {
    capture.reasoningSectionOpen = true;
    thinkingLog(`[reasoning]
`);
  }
  if (kind === "text" && !capture.textSectionOpen) {
    capture.textSectionOpen = true;
    thinkingLog(`${capture.reasoningSectionOpen ? `
` : ""}[text]
`);
  }
  thinkingLog(chunk);
}
function recordCommentaryFn(capture, itemId, name, args, replace) {
  if (typeof args !== "string" || args.length === 0)
    return;
  const existing = capture.channels.commentary.fn.get(itemId);
  if (!existing) {
    capture.channels.commentary.fn.set(itemId, { itemId, name, args });
  } else {
    if (name && !existing.name)
      existing.name = name;
    existing.args = replace ? args : existing.args + args;
  }
  harmonyEventLog({
    phase: replace ? "response.tool_call.done" : "response.tool_call.delta",
    requestId: capture.requestId,
    sessionId: capture.sessionId,
    path: capture.path,
    model: capture.model,
    channel: "commentary",
    toolType: "function_call",
    itemId,
    name,
    ...shapeHarmonyContent(args)
  });
}
function recordCommentaryCustom(capture, itemId, name, input, replace) {
  if (typeof input !== "string" || input.length === 0)
    return;
  const existing = capture.channels.commentary.custom.get(itemId);
  if (!existing) {
    capture.channels.commentary.custom.set(itemId, { itemId, name, input });
  } else {
    if (name && !existing.name)
      existing.name = name;
    existing.input = replace ? input : existing.input + input;
  }
  harmonyEventLog({
    phase: replace ? "response.tool_call.done" : "response.tool_call.delta",
    requestId: capture.requestId,
    sessionId: capture.sessionId,
    path: capture.path,
    model: capture.model,
    channel: "commentary",
    toolType: "custom_tool_call",
    itemId,
    name,
    ...shapeHarmonyContent(input)
  });
}
function captureSnapshot(capture) {
  return {
    requestId: capture.requestId,
    path: capture.path,
    sessionId: capture.sessionId,
    startedAt: capture.startedAt,
    model: capture.model,
    inputTokens: capture.inputTokens,
    outputTokens: capture.outputTokens,
    stopReason: capture.stopReason,
    channels: {
      final: capture.channels.final.join(""),
      analysis: capture.channels.analysis.join(""),
      commentary: {
        fn: [...capture.channels.commentary.fn.values()].map((c) => ({ ...c })),
        custom: [...capture.channels.commentary.custom.values()].map((c) => ({ ...c }))
      }
    },
    inputTiers: capture.inputTiers
  };
}
function extractUsage(response) {
  const usage = response?.usage;
  const input = typeof usage?.input_tokens === "number" ? usage.input_tokens : null;
  const output = typeof usage?.output_tokens === "number" ? usage.output_tokens : null;
  return { input, output };
}
function extractStopReason(response) {
  return response?.stop_reason || response?.incomplete_details?.reason || response?.error?.code || response?.status || "unknown";
}
function mergeResponseEnvelope(envelope, response) {
  if (!response || typeof response !== "object")
    return false;
  let changed = false;
  const setStr = (cur, key) => {
    const v = response[key];
    if (typeof v === "string" && v !== cur) {
      changed = true;
      return v;
    }
    return cur;
  };
  const setBool = (cur, key) => {
    const v = response[key];
    if (typeof v === "boolean" && v !== cur) {
      changed = true;
      return v;
    }
    return cur;
  };
  const setObj = (cur, key) => {
    const v = response[key];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const ser = JSON.stringify(v);
      if (JSON.stringify(cur) !== ser) {
        changed = true;
        return v;
      }
    }
    return cur;
  };
  envelope.serviceTier = setStr(envelope.serviceTier, "service_tier");
  envelope.safetyIdentifier = setStr(envelope.safetyIdentifier, "safety_identifier");
  envelope.previousResponseId = setStr(envelope.previousResponseId, "previous_response_id");
  envelope.truncation = setStr(envelope.truncation, "truncation");
  envelope.store = setBool(envelope.store, "store");
  envelope.parallelToolCalls = setBool(envelope.parallelToolCalls, "parallel_tool_calls");
  const pcr = response.prompt_cache_retention;
  if ((typeof pcr === "string" || typeof pcr === "number") && pcr !== envelope.promptCacheRetention) {
    envelope.promptCacheRetention = pcr;
    changed = true;
  }
  const tc = response.tool_choice;
  if (typeof tc === "string" && tc !== envelope.toolChoice) {
    envelope.toolChoice = tc;
    changed = true;
  } else if (tc && typeof tc === "object" && JSON.stringify(tc) !== JSON.stringify(envelope.toolChoice)) {
    envelope.toolChoice = tc;
    changed = true;
  }
  envelope.toolUsage = setObj(envelope.toolUsage, "tool_usage");
  envelope.moderation = setObj(envelope.moderation, "moderation");
  const reasoning = response.reasoning;
  if (reasoning && typeof reasoning === "object") {
    if (typeof reasoning.effort === "string" && reasoning.effort !== envelope.reasoningEffort) {
      envelope.reasoningEffort = reasoning.effort;
      changed = true;
    }
    if (typeof reasoning.summary === "string" && reasoning.summary !== envelope.reasoningSummary) {
      envelope.reasoningSummary = reasoning.summary;
      changed = true;
    }
  }
  const text = response.text;
  if (text && typeof text === "object") {
    if (typeof text.verbosity === "string" && text.verbosity !== envelope.textVerbosity) {
      envelope.textVerbosity = text.verbosity;
      changed = true;
    }
    if (text.format && typeof text.format === "object" && typeof text.format.type === "string" && text.format.type !== envelope.textFormatType) {
      envelope.textFormatType = text.format.type;
      changed = true;
    }
  }
  return changed;
}
var CYBER_POLICY_CODES = new Set([
  "cyber_policy",
  "policy_violation",
  "content_policy_violation",
  "moderation_blocked"
]);
function extractErrorFields(blob) {
  if (!blob || typeof blob !== "object") {
    return { code: null, message: null, type: null, param: null };
  }
  const get = (k) => {
    const v = blob[k];
    return typeof v === "string" ? v : null;
  };
  return {
    code: get("code"),
    message: get("message"),
    type: get("type"),
    param: get("param")
  };
}
function isCyberPolicyCode(code) {
  if (!code)
    return false;
  return CYBER_POLICY_CODES.has(code.toLowerCase());
}
function scanItemForFallback(capture, item, includeReasoning, includeText) {
  if (!item || typeof item !== "object")
    return;
  if (includeText && item.type === "message" && Array.isArray(item.content)) {
    for (const part of item.content) {
      if (part?.type === "output_text") {
        appendLiveChunk(capture, "text", part.text);
      }
      if (includeReasoning && (part?.type === "reasoning_text" || part?.type === "summary_text")) {
        appendLiveChunk(capture, "reasoning", part.text);
      }
    }
  }
  if (includeReasoning && item.type === "reasoning") {
    if (Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part?.type === "reasoning_text") {
          appendLiveChunk(capture, "reasoning", part.text);
        }
      }
    }
    if (Array.isArray(item.summary)) {
      for (const part of item.summary) {
        if (part?.type === "summary_text") {
          appendLiveChunk(capture, "reasoning", part.text);
        }
      }
    }
  }
}
function flushCapture(capture) {
  if (capture.flushed)
    return;
  capture.flushed = true;
  const finalParts = capture.channels.final;
  const analysisParts = capture.channels.analysis;
  harmonyEventLog({
    phase: "response.completed",
    requestId: capture.requestId,
    sessionId: capture.sessionId,
    path: capture.path,
    model: capture.model,
    responseId: capture.responseId,
    inputTokens: capture.inputTokens,
    outputTokens: capture.outputTokens,
    stopReason: capture.stopReason,
    finalLen: finalParts.reduce((acc, s) => acc + s.length, 0),
    analysisLen: analysisParts.reduce((acc, s) => acc + s.length, 0),
    fnCalls: capture.channels.commentary.fn.size,
    customCalls: capture.channels.commentary.custom.size,
    metadata: capture.metadata,
    encryptedReasoningCount: capture.encryptedReasoningSizes.length,
    encryptedReasoningTotalBytes: capture.encryptedReasoningSizes.reduce((a, b) => a + b, 0)
  });
  if (!capture.envelopeEmitted) {
    capture.envelopeEmitted = true;
    harmonyEventLog({
      phase: "response.envelope_captured",
      requestId: capture.requestId,
      sessionId: capture.sessionId,
      path: capture.path,
      model: capture.model,
      responseId: capture.responseId,
      stopReason: capture.stopReason,
      envelope: capture.envelope
    });
  }
  const finalText = finalParts.join("");
  const analysisText = analysisParts.join("");
  const refusal = detectRefusal(finalText);
  const divergence = divergenceVerdict(finalText, analysisText);
  if (refusal.isRefusal || divergence.divergent) {
    harmonyEventLog({
      phase: "response.refusal_detected",
      requestId: capture.requestId,
      sessionId: capture.sessionId,
      path: capture.path,
      model: capture.model,
      responseId: capture.responseId,
      finalLen: divergence.finalLen,
      analysisLen: divergence.analysisLen,
      refusal: {
        isRefusal: refusal.isRefusal,
        matchCount: refusal.matches.length,
        patterns: refusal.matches.map((m) => m.pattern),
        firstSnippet: refusal.matches[0]?.snippet ?? null
      },
      divergence: {
        divergent: divergence.divergent,
        reason: divergence.reason
      },
      analysisLooksLikeRefusal: divergence.analysisLooksLikeRefusal
    });
  }
  try {
    hooks.onResponseComplete?.(captureSnapshot(capture));
  } catch (error) {
    console.error(`[proxy] onResponseComplete hook failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (capture.logStarted) {
    thinkingLog(`
[${formatTime()}] done | out=${capture.outputTokens ?? "?"} | stop=${capture.stopReason}
`);
    return;
  }
  if (analysisParts.length === 0 && finalParts.length === 0) {
    return;
  }
  const sections = [
    "",
    SEPARATOR,
    `[${formatTime(capture.startedAt)}] ${capture.model} | in=${capture.inputTokens ?? "?"}`,
    SEPARATOR
  ];
  if (analysisParts.length > 0) {
    sections.push("[reasoning]");
    sections.push(analysisParts.join(""));
  }
  if (finalParts.length > 0) {
    sections.push("[text]");
    sections.push(finalParts.join(""));
  }
  sections.push(`[${formatTime()}] done | out=${capture.outputTokens ?? "?"} | stop=${capture.stopReason}`);
  thinkingLog(`${sections.join(`
`)}
`);
}
function harvestMetadata(node, capture, depth = 0) {
  if (depth > 6 || !node || typeof node !== "object")
    return false;
  let found = false;
  if (Array.isArray(node)) {
    for (const item of node)
      found = harvestMetadata(item, capture, depth + 1) || found;
    return found;
  }
  if (node.metadata && typeof node.metadata === "object" && !Array.isArray(node.metadata)) {
    const md = node.metadata;
    if (Object.keys(md).length > 0) {
      capture.metadata = { ...capture.metadata, ...md };
      found = true;
    }
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === "object")
      found = harvestMetadata(v, capture, depth + 1) || found;
  }
  return found;
}
function processChatCompletionChunk(event, capture) {
  if (typeof event.model === "string") {
    if (capture.model === "unknown" || capture.model === "-") {
      capture.model = event.model;
    }
    if (capture.responseId === null && typeof event.id === "string") {
      capture.responseId = event.id;
    }
  }
  if (typeof event.provider === "string" && !capture.envelope.openrouterProvider) {
    capture.envelope.openrouterProvider = event.provider;
  }
  const choices = Array.isArray(event.choices) ? event.choices : [];
  for (const choice of choices) {
    if (!choice || typeof choice !== "object")
      continue;
    const index = typeof choice.index === "number" ? choice.index : 0;
    const delta = choice.delta && typeof choice.delta === "object" ? choice.delta : null;
    if (delta) {
      if (typeof delta.content === "string" && delta.content.length > 0) {
        appendLiveChunk(capture, "text", delta.content);
      }
      let analysisAppended = false;
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
        appendLiveChunk(capture, "reasoning", delta.reasoning_content);
        analysisAppended = true;
      } else if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) {
        appendLiveChunk(capture, "reasoning", delta.reasoning);
        analysisAppended = true;
      }
      if (!analysisAppended && Array.isArray(delta.reasoning_details)) {
        for (const detail of delta.reasoning_details) {
          if (detail && typeof detail === "object" && typeof detail.summary === "string" && detail.summary.length > 0) {
            appendLiveChunk(capture, "reasoning", detail.summary);
          }
        }
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          if (!tc || typeof tc !== "object")
            continue;
          const tcIndex = typeof tc.index === "number" ? tc.index : index;
          const itemId = `cc-${capture.requestId}-${tcIndex}`;
          const fn = tc.function && typeof tc.function === "object" ? tc.function : null;
          const name = fn && typeof fn.name === "string" ? fn.name : null;
          const args = fn && typeof fn.arguments === "string" ? fn.arguments : undefined;
          if (name || args) {
            recordCommentaryFn(capture, itemId, name, args, false);
          }
        }
      }
    }
    if (typeof choice.finish_reason === "string") {
      capture.stopReason = choice.finish_reason;
    }
  }
  const usage = event.usage;
  if (usage && typeof usage === "object") {
    if (typeof usage.prompt_tokens === "number")
      capture.inputTokens = usage.prompt_tokens;
    if (typeof usage.completion_tokens === "number")
      capture.outputTokens = usage.completion_tokens;
  }
}
function processSseEvent(event, capture) {
  if (event && event.object === "chat.completion.chunk") {
    processChatCompletionChunk(event, capture);
    return;
  }
  const before = JSON.stringify(capture.metadata);
  harvestMetadata(event, capture);
  if (JSON.stringify(capture.metadata) !== before) {
    harmonyEventLog({
      phase: "response.metadata_observed",
      requestId: capture.requestId,
      sessionId: capture.sessionId,
      path: capture.path,
      eventType: typeof event.type === "string" ? event.type : "unknown",
      metadata: capture.metadata
    });
  }
  switch (event.type) {
    case "response.created": {
      const response = event.response;
      capture.model = typeof response?.model === "string" ? response.model : capture.model;
      capture.responseId = typeof response?.id === "string" ? response.id : capture.responseId;
      const usage = extractUsage(response);
      capture.inputTokens = usage.input ?? capture.inputTokens;
      mergeResponseEnvelope(capture.envelope, response);
      break;
    }
    case "response.metadata": {
      if (typeof event.response_id === "string") {
        capture.responseId = event.response_id;
      }
      break;
    }
    case "response.content_part.added": {
      const part = event.part;
      if (part?.type === "output_text") {
        appendLiveChunk(capture, "text", part.text);
      }
      if (part?.type === "reasoning_text" || part?.type === "summary_text") {
        appendLiveChunk(capture, "reasoning", part.text);
      }
      break;
    }
    case "response.output_text.delta": {
      capture.seenTextParts.add(eventKey(event, "content_index"));
      appendLiveChunk(capture, "text", event.delta);
      break;
    }
    case "response.output_text.done": {
      const key = eventKey(event, "content_index");
      if (!capture.seenTextParts.has(key)) {
        appendLiveChunk(capture, "text", event.text);
      }
      capture.seenTextParts.add(key);
      break;
    }
    case "response.reasoning_text.delta": {
      capture.seenReasoningParts.add(eventKey(event, "content_index"));
      appendLiveChunk(capture, "reasoning", event.delta);
      break;
    }
    case "response.reasoning_text.done": {
      const key = eventKey(event, "content_index");
      if (!capture.seenReasoningParts.has(key)) {
        appendLiveChunk(capture, "reasoning", event.text);
      }
      capture.seenReasoningParts.add(key);
      break;
    }
    case "response.reasoning_summary_part.added": {
      const part = event.part;
      if (part?.type === "summary_text") {
        appendLiveChunk(capture, "reasoning", part.text);
      }
      break;
    }
    case "response.reasoning_summary_part.done": {
      const key = eventKey(event, "summary_index");
      const part = event.part;
      if (!capture.seenReasoningParts.has(key) && part?.type === "summary_text") {
        appendLiveChunk(capture, "reasoning", part.text);
      }
      capture.seenReasoningParts.add(key);
      break;
    }
    case "response.reasoning_summary_text.delta": {
      capture.seenReasoningParts.add(eventKey(event, "summary_index"));
      appendLiveChunk(capture, "reasoning", event.delta);
      break;
    }
    case "response.reasoning_summary_text.done": {
      const key = eventKey(event, "summary_index");
      if (!capture.seenReasoningParts.has(key)) {
        appendLiveChunk(capture, "reasoning", event.text);
      }
      capture.seenReasoningParts.add(key);
      break;
    }
    case "response.output_item.added": {
      const item = event.item;
      if (item?.type === "function_call" && typeof item.id === "string") {
        recordCommentaryFn(capture, item.id, typeof item.name === "string" ? item.name : null, typeof item.arguments === "string" && item.arguments.length > 0 ? item.arguments : undefined, true);
      }
      if (item?.type === "custom_tool_call" && typeof item.id === "string") {
        recordCommentaryCustom(capture, item.id, typeof item.name === "string" ? item.name : null, typeof item.input === "string" && item.input.length > 0 ? item.input : undefined, true);
      }
      if (item?.type === "reasoning" && typeof item.encrypted_content === "string") {
        capture.encryptedReasoningSizes.push(item.encrypted_content.length);
        try {
          const fernet = decodeFernet(item.encrypted_content);
          harmonyEventLog({
            phase: "response.encrypted_reasoning",
            requestId: capture.requestId,
            sessionId: capture.sessionId,
            path: capture.path,
            model: capture.model,
            itemId: typeof item.id === "string" ? item.id : null,
            fernet: {
              tokenLen: item.encrypted_content.length,
              totalBytes: fernet.totalBytes,
              version: fernet.version,
              timestamp: fernet.timestamp,
              iso: fernet.iso,
              ivHex: fernet.ivHex,
              ciphertextBytes: fernet.ciphertextBytes,
              ciphertextBlocks: fernet.ciphertextBlocks,
              hmacHex: fernet.hmacHex
            }
          });
        } catch (err) {
          harmonyEventLog({
            phase: "response.encrypted_reasoning_decode_error",
            requestId: capture.requestId,
            sessionId: capture.sessionId,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
      break;
    }
    case "response.function_call_arguments.delta": {
      const itemId = typeof event.item_id === "string" ? event.item_id : `output:${event.output_index ?? "?"}`;
      recordCommentaryFn(capture, itemId, null, typeof event.delta === "string" ? event.delta : undefined, false);
      break;
    }
    case "response.function_call_arguments.done": {
      const itemId = typeof event.item_id === "string" ? event.item_id : `output:${event.output_index ?? "?"}`;
      recordCommentaryFn(capture, itemId, null, typeof event.arguments === "string" ? event.arguments : undefined, true);
      break;
    }
    case "response.custom_tool_call_input.delta": {
      const itemId = typeof event.item_id === "string" ? event.item_id : `output:${event.output_index ?? "?"}`;
      recordCommentaryCustom(capture, itemId, null, typeof event.delta === "string" ? event.delta : undefined, false);
      break;
    }
    case "response.custom_tool_call_input.done": {
      const itemId = typeof event.item_id === "string" ? event.item_id : `output:${event.output_index ?? "?"}`;
      recordCommentaryCustom(capture, itemId, null, typeof event.input === "string" ? event.input : undefined, true);
      break;
    }
    case "response.output_item.done": {
      const item = event.item;
      if (item?.type === "function_call" && typeof item.id === "string") {
        recordCommentaryFn(capture, item.id, typeof item.name === "string" ? item.name : null, typeof item.arguments === "string" && item.arguments.length > 0 ? item.arguments : undefined, true);
      }
      if (item?.type === "custom_tool_call" && typeof item.id === "string") {
        recordCommentaryCustom(capture, item.id, typeof item.name === "string" ? item.name : null, typeof item.input === "string" && item.input.length > 0 ? item.input : undefined, true);
      }
      if (capture.channels.analysis.length === 0 || capture.channels.final.length === 0) {
        scanItemForFallback(capture, item, capture.channels.analysis.length === 0, capture.channels.final.length === 0);
      }
      break;
    }
    case "error": {
      const errBlob = event.error && typeof event.error === "object" ? event.error : event;
      const fields = extractErrorFields(errBlob);
      const record = {
        source: "sse_error_event",
        code: fields.code,
        message: fields.message,
        type: fields.type,
        param: fields.param,
        raw: errBlob,
        at: new Date().toISOString()
      };
      capture.errors.push(record);
      harmonyEventLog({
        phase: "response.error_event",
        requestId: capture.requestId,
        sessionId: capture.sessionId,
        path: capture.path,
        model: capture.model,
        responseId: capture.responseId,
        source: "sse_error_event",
        code: record.code,
        type: record.type,
        param: record.param,
        message: record.message,
        cyberPolicy: isCyberPolicyCode(record.code)
      });
      if (isCyberPolicyCode(record.code)) {
        harmonyEventLog({
          phase: "response.cyber_policy_blocked",
          requestId: capture.requestId,
          sessionId: capture.sessionId,
          path: capture.path,
          model: capture.model,
          responseId: capture.responseId,
          code: record.code,
          message: record.message,
          source: "sse_error_event"
        });
      }
      break;
    }
    case "response.completed":
    case "response.incomplete":
    case "response.failed": {
      const response = event.response;
      const usage = extractUsage(response);
      capture.model = typeof response?.model === "string" ? response.model : capture.model;
      capture.inputTokens = usage.input ?? capture.inputTokens;
      capture.outputTokens = usage.output ?? capture.outputTokens;
      capture.stopReason = extractStopReason(response);
      mergeResponseEnvelope(capture.envelope, response);
      if (event.type === "response.failed") {
        const errBlob = response?.error;
        const fields = extractErrorFields(errBlob);
        const record = {
          source: "response_failed",
          code: fields.code,
          message: fields.message,
          type: fields.type,
          param: fields.param,
          raw: errBlob ?? {},
          at: new Date().toISOString()
        };
        capture.errors.push(record);
        harmonyEventLog({
          phase: "response.error_event",
          requestId: capture.requestId,
          sessionId: capture.sessionId,
          path: capture.path,
          model: capture.model,
          responseId: capture.responseId,
          code: record.code,
          type: record.type,
          param: record.param,
          message: record.message,
          cyberPolicy: isCyberPolicyCode(record.code),
          source: "response_failed"
        });
        if (isCyberPolicyCode(record.code)) {
          harmonyEventLog({
            phase: "response.cyber_policy_blocked",
            requestId: capture.requestId,
            sessionId: capture.sessionId,
            path: capture.path,
            model: capture.model,
            responseId: capture.responseId,
            code: record.code,
            message: record.message,
            source: "response_failed"
          });
        }
      }
      const alreadyRecordedAsError = capture.errors.some((e) => e.source === "response_failed");
      if (!alreadyRecordedAsError && isCyberPolicyCode(capture.stopReason)) {
        const record = {
          source: "response_failed",
          code: capture.stopReason || "cyber_policy",
          message: typeof response?.incomplete_details?.reason === "string" ? response.incomplete_details.reason : null,
          type: null,
          param: null,
          raw: { stop_reason: capture.stopReason, incomplete_details: response?.incomplete_details, metadata: response?.metadata },
          at: new Date().toISOString()
        };
        capture.errors.push(record);
        harmonyEventLog({
          phase: "response.error_event",
          requestId: capture.requestId,
          sessionId: capture.sessionId,
          path: capture.path,
          model: capture.model,
          responseId: capture.responseId,
          source: "response_completed_stop_reason",
          code: record.code,
          message: record.message,
          cyberPolicy: true,
          metadata: response?.metadata ?? null
        });
        harmonyEventLog({
          phase: "response.cyber_policy_blocked",
          requestId: capture.requestId,
          sessionId: capture.sessionId,
          path: capture.path,
          model: capture.model,
          responseId: capture.responseId,
          code: record.code,
          source: "response_completed_stop_reason",
          metadata: response?.metadata ?? null
        });
      }
      if ((capture.channels.analysis.length === 0 || capture.channels.final.length === 0) && Array.isArray(response?.output)) {
        for (const item of response.output) {
          scanItemForFallback(capture, item, capture.channels.analysis.length === 0, capture.channels.final.length === 0);
        }
      }
      flushCapture(capture);
      break;
    }
  }
}
function parseSseBlock(block, capture) {
  const lines = block.split(`
`);
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0)
    return { action: "passthrough" };
  const payload = dataLines.join(`
`);
  if (payload === "[DONE]")
    return { action: "passthrough" };
  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return { action: "passthrough" };
  }
  rawEventLog(event, capture);
  apiJsonLog({
    phase: "response.sse_event",
    requestId: capture.requestId,
    path: capture.path,
    sessionId: capture.sessionId,
    model: capture.model,
    type: typeof event.type === "string" ? event.type : "unknown",
    event
  });
  let outcome = { action: "passthrough" };
  let effectiveEvent = event;
  const eventChannel = channelForEventType(typeof event.type === "string" ? event.type : null);
  const profile = capture.profile;
  if (profile && shouldDropChannel(eventChannel, profile.def)) {
    harmonyEventLog({
      phase: "response.profile_channel_dropped",
      requestId: capture.requestId,
      sessionId: capture.sessionId,
      path: capture.path,
      profile: profile.name,
      channel: eventChannel,
      type: typeof event.type === "string" ? event.type : "unknown"
    });
    processSseEvent(effectiveEvent, capture);
    return { action: "drop" };
  }
  if (hooks.onSseEvent) {
    try {
      const result = hooks.onSseEvent(event, {
        channel: eventChannel,
        requestId: capture.requestId,
        path: capture.path,
        sessionId: capture.sessionId
      });
      if (result === "drop") {
        harmonyEventLog({
          phase: "response.sse_event_dropped",
          requestId: capture.requestId,
          sessionId: capture.sessionId,
          path: capture.path,
          model: capture.model,
          type: typeof event.type === "string" ? event.type : "unknown"
        });
        outcome = { action: "drop" };
        return outcome;
      }
      if (result && result !== event) {
        effectiveEvent = result;
        outcome = { action: "mutate", event: result };
        harmonyEventLog({
          phase: "response.sse_event_mutated",
          requestId: capture.requestId,
          sessionId: capture.sessionId,
          path: capture.path,
          model: capture.model,
          type: typeof event.type === "string" ? event.type : "unknown"
        });
      }
    } catch (error) {
      console.error(`[proxy] onSseEvent hook failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  processSseEvent(effectiveEvent, capture);
  return outcome;
}
function reconstructSseBlock(event) {
  const type = typeof event.type === "string" ? event.type : null;
  const lines = [];
  if (type)
    lines.push(`event: ${type}`);
  lines.push(`data: ${JSON.stringify(event)}`);
  return lines.join(`
`) + `

`;
}
function makeEmptyCapture(requestModel, context) {
  return {
    requestId: context.requestId || "-",
    path: context.path || "-",
    sessionId: context.sessionId || null,
    startedAt: Date.now(),
    model: requestModel === "-" ? "unknown" : requestModel,
    inputTokens: null,
    outputTokens: null,
    stopReason: "stream_closed",
    channels: {
      final: [],
      analysis: [],
      commentary: {
        fn: new Map,
        custom: new Map
      }
    },
    inputTiers: {},
    metadata: {},
    responseId: null,
    encryptedReasoningSizes: [],
    errors: [],
    envelope: emptyEnvelope(),
    envelopeEmitted: false,
    profile: context.requestId ? requestProfileMap.get(context.requestId) || null : null,
    seenTextParts: new Set,
    seenReasoningParts: new Set,
    logStarted: false,
    reasoningSectionOpen: false,
    textSectionOpen: false,
    flushed: false
  };
}
function interceptStream(body, requestModel, context = {}) {
  const decoder = new TextDecoder;
  const capture = makeEmptyCapture(requestModel, context);
  const profileFiltersChannels = !!capture.profile && capture.profile.def.readChannels.length < 3;
  const hooksActive = typeof hooks.onSseEvent === "function" || profileFiltersChannels;
  const utf8Encoder = new TextEncoder;
  let buffer = "";
  return new ReadableStream({
    async start(controller) {
      const reader = body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          if (!hooksActive) {
            controller.enqueue(value);
          }
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, `
`);
          let boundary = buffer.indexOf(`

`);
          while (boundary !== -1) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const outcome = parseSseBlock(block, capture);
            if (hooksActive) {
              if (outcome.action === "drop") {} else if (outcome.action === "mutate") {
                controller.enqueue(utf8Encoder.encode(reconstructSseBlock(outcome.event)));
              } else {
                controller.enqueue(utf8Encoder.encode(`${block}

`));
              }
            }
            boundary = buffer.indexOf(`

`);
          }
        }
        buffer += decoder.decode();
        if (buffer.trim().length > 0) {
          const outcome = parseSseBlock(buffer, capture);
          if (hooksActive) {
            if (outcome.action === "drop") {} else if (outcome.action === "mutate") {
              controller.enqueue(utf8Encoder.encode(reconstructSseBlock(outcome.event)));
            } else {
              controller.enqueue(utf8Encoder.encode(buffer));
            }
          }
        }
      } finally {
        flushCapture(capture);
        controller.close();
      }
    }
  });
}
function appendString(target, value) {
  if (typeof value === "string" && value.length > 0) {
    target.push(value);
  }
}
function entryRequestId(entry) {
  return typeof entry.requestId === "string" && entry.requestId.length > 0 ? entry.requestId : "unknown";
}
function itemKey(event, item) {
  const itemId = item?.id || event.item_id;
  if (typeof itemId === "string" && itemId.length > 0)
    return itemId;
  return `output:${event.output_index ?? "unknown"}`;
}
function toolCallFor(toolCalls, key, entry, defaults = {}) {
  let call = toolCalls.get(key);
  if (!call) {
    call = {
      id: key,
      firstAt: entry.at ?? null,
      lastAt: entry.at ?? null,
      requestId: entryRequestId(entry),
      type: defaults.type || "tool_call",
      name: defaults.name || null,
      callId: defaults.callId || null,
      status: defaults.status || null,
      arguments: "",
      input: "",
      eventTypes: [],
      argumentChunks: [],
      inputChunks: []
    };
    toolCalls.set(key, call);
  }
  call.lastAt = entry.at ?? call.lastAt;
  for (const [field, value] of Object.entries(defaults)) {
    if (value !== undefined && value !== null && value !== "") {
      call[field] = value;
    }
  }
  return call;
}
function recordToolItem(toolCalls, entry, event) {
  const item = event.item;
  if (!item?.type || item.type === "message" || item.type === "reasoning")
    return;
  const call = toolCallFor(toolCalls, itemKey(event, item), entry, {
    type: item.type,
    name: item.name,
    callId: item.call_id,
    status: item.status
  });
  call.eventTypes.push(event.type);
  if (typeof item.arguments === "string" && item.arguments.length > 0) {
    call.arguments = item.arguments;
  }
  if (typeof item.input === "string" && item.input.length > 0) {
    call.input = item.input;
  }
}
function compactToolCall(call) {
  const argumentChunks = Array.isArray(call.argumentChunks) ? call.argumentChunks : [];
  const inputChunks = Array.isArray(call.inputChunks) ? call.inputChunks : [];
  const eventTypes = Array.isArray(call.eventTypes) ? call.eventTypes : [];
  return {
    id: call.id,
    firstAt: call.firstAt,
    lastAt: call.lastAt,
    requestId: call.requestId,
    type: call.type,
    name: call.name,
    callId: call.callId,
    status: call.status,
    arguments: typeof call.arguments === "string" && call.arguments.length > 0 ? call.arguments : argumentChunks.join(""),
    input: typeof call.input === "string" && call.input.length > 0 ? call.input : inputChunks.join(""),
    eventTypes
  };
}
function collectOutputTextFromItem(item) {
  const chunks = [];
  if (!item || item.type !== "message" || !Array.isArray(item.content))
    return chunks;
  for (const part of item.content) {
    if (part?.type === "output_text") {
      appendString(chunks, part.text);
    }
  }
  return chunks;
}
function collectReasoningFromItem(item) {
  const chunks = [];
  if (!item || item.type !== "reasoning")
    return chunks;
  if (Array.isArray(item.content)) {
    for (const part of item.content) {
      if (part?.type === "reasoning_text") {
        appendString(chunks, part.text);
      }
    }
  }
  if (Array.isArray(item.summary)) {
    for (const part of item.summary) {
      if (part?.type === "summary_text") {
        appendString(chunks, part.text);
      }
    }
  }
  return chunks;
}
function buildFlatTranscript(events) {
  const assistantChunks = [];
  const reasoningChunks = [];
  const responseSnapshots = [];
  const toolCalls = new Map;
  const toolEvents = [];
  const eventTypes = {};
  const seenAssistantKeys = new Set;
  const seenReasoningKeys = new Set;
  for (const entry of events) {
    const event = entry.event;
    if (!event || typeof event !== "object")
      continue;
    const type = typeof event.type === "string" ? event.type : "unknown";
    eventTypes[type] = (eventTypes[type] || 0) + 1;
    switch (type) {
      case "response.content_part.added": {
        const part = event.part;
        if (part?.type === "output_text") {
          appendString(assistantChunks, part.text);
        }
        if (part?.type === "reasoning_text" || part?.type === "summary_text") {
          appendString(reasoningChunks, part.text);
        }
        break;
      }
      case "response.content_part.done": {
        const key = eventKey(event, "content_index");
        const part = event.part;
        if (!seenAssistantKeys.has(key) && part?.type === "output_text") {
          appendString(assistantChunks, part.text);
        }
        if (!seenReasoningKeys.has(key) && (part?.type === "reasoning_text" || part?.type === "summary_text")) {
          appendString(reasoningChunks, part.text);
        }
        seenAssistantKeys.add(key);
        seenReasoningKeys.add(key);
        break;
      }
      case "response.output_text.delta":
        seenAssistantKeys.add(eventKey(event, "content_index"));
        appendString(assistantChunks, event.delta);
        break;
      case "response.output_text.done": {
        const key = eventKey(event, "content_index");
        if (!seenAssistantKeys.has(key)) {
          appendString(assistantChunks, event.text);
        }
        seenAssistantKeys.add(key);
        break;
      }
      case "response.reasoning_text.delta":
        seenReasoningKeys.add(eventKey(event, "content_index"));
        appendString(reasoningChunks, event.delta);
        break;
      case "response.reasoning_text.done": {
        const key = eventKey(event, "content_index");
        if (!seenReasoningKeys.has(key)) {
          appendString(reasoningChunks, event.text);
        }
        seenReasoningKeys.add(key);
        break;
      }
      case "response.reasoning_summary_text.delta":
        seenReasoningKeys.add(eventKey(event, "summary_index"));
        appendString(reasoningChunks, event.delta);
        break;
      case "response.reasoning_summary_text.done": {
        const key = eventKey(event, "summary_index");
        if (!seenReasoningKeys.has(key)) {
          appendString(reasoningChunks, event.text);
        }
        seenReasoningKeys.add(key);
        break;
      }
      case "response.reasoning_summary_part.added":
      case "response.reasoning_summary_part.done": {
        const key = eventKey(event, "summary_index");
        const part = event.part;
        if (!seenReasoningKeys.has(key) && part?.type === "summary_text") {
          appendString(reasoningChunks, part.text);
        }
        seenReasoningKeys.add(key);
        break;
      }
      case "response.output_item.added":
      case "response.output_item.done": {
        const item = event.item;
        if (item?.type && item.type !== "message" && item.type !== "reasoning") {
          toolEvents.push({ at: entry.at, requestId: entry.requestId, type, item });
        }
        recordToolItem(toolCalls, entry, event);
        break;
      }
      case "response.function_call_arguments.delta": {
        const call = toolCallFor(toolCalls, itemKey(event), entry, { type: "function_call" });
        call.eventTypes.push(type);
        appendString(call.argumentChunks, event.delta);
        break;
      }
      case "response.function_call_arguments.done": {
        const call = toolCallFor(toolCalls, itemKey(event), entry, { type: "function_call" });
        call.eventTypes.push(type);
        if (typeof event.arguments === "string") {
          call.arguments = event.arguments;
        }
        break;
      }
      case "response.custom_tool_call_input.delta": {
        const call = toolCallFor(toolCalls, itemKey(event), entry, { type: "custom_tool_call" });
        call.eventTypes.push(type);
        appendString(call.inputChunks, event.delta);
        break;
      }
      case "response.custom_tool_call_input.done": {
        const call = toolCallFor(toolCalls, itemKey(event), entry, { type: "custom_tool_call" });
        call.eventTypes.push(type);
        if (typeof event.input === "string") {
          call.input = event.input;
        }
        break;
      }
      case "response.completed":
      case "response.incomplete":
      case "response.failed": {
        const response = event.response;
        if (!response)
          break;
        const snapshot = {
          at: entry.at,
          requestId: entry.requestId,
          status: response.status,
          model: response.model,
          usage: response.usage,
          assistantText: [],
          reasoningText: [],
          tools: []
        };
        if (Array.isArray(response.output)) {
          for (const item of response.output) {
            snapshot.assistantText.push(...collectOutputTextFromItem(item));
            snapshot.reasoningText.push(...collectReasoningFromItem(item));
            if (item?.type && item.type !== "message" && item.type !== "reasoning") {
              snapshot.tools.push(item);
            }
          }
        }
        responseSnapshots.push(snapshot);
        break;
      }
    }
    if (type.includes("tool") || type.includes("function_call") || type.includes("mcp")) {
      toolEvents.push({ at: entry.at, requestId: entry.requestId, type, event });
    }
  }
  const assistantText = assistantChunks.join("");
  const reasoningText = reasoningChunks.join("");
  return {
    channels: {
      commentary: assistantText,
      analysis: reasoningText
    },
    assistantText,
    reasoningText,
    toolCalls: [...toolCalls.values()].map(compactToolCall),
    toolEvents,
    responseSnapshots,
    eventTypes
  };
}
function buildTranscript(events) {
  const grouped = new Map;
  for (const event of events) {
    const requestId = entryRequestId(event);
    const requestEvents = grouped.get(requestId) || [];
    requestEvents.push(event);
    grouped.set(requestId, requestEvents);
  }
  return {
    ...buildFlatTranscript(events),
    requests: [...grouped.entries()].map(([requestId, requestEvents]) => ({
      requestId,
      firstAt: requestEvents[0]?.at ?? null,
      lastAt: requestEvents[requestEvents.length - 1]?.at ?? null,
      eventCount: requestEvents.length,
      ...buildFlatTranscript(requestEvents)
    }))
  };
}
app.get("/health", async (c) => {
  try {
    const auth = await getStoredAuthInfo();
    return c.json({
      status: "ok",
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      upstream: `${UPSTREAM_ORIGIN}${UPSTREAM_BASE_PATH}`,
      auth: {
        path: getAuthPath(),
        mode: auth.authMode,
        accountId: auth.accountId,
        organizationId: auth.organizationId,
        scopes: auth.scopes,
        expiresAt: auth.expiresAt || null,
        expiresIn: auth.expiresAt ? Math.floor((auth.expiresAt - Date.now()) / 1000) : null
      },
      thinkingLog: THINKING_LOG_PATH,
      rawEventLog: {
        enabled: RAW_EVENT_LOG_ENABLED,
        path: RAW_EVENT_LOG_PATH
      },
      requestLog: {
        enabled: REQUEST_LOG_ENABLED,
        path: REQUEST_LOG_PATH
      },
      apiJsonLog: {
        enabled: API_JSON_LOG_ENABLED,
        path: API_JSON_LOG_PATH
      },
      harmonyLog: {
        enabled: HARMONY_LOG_ENABLED,
        path: HARMONY_LOG_PATH,
        contentMode: HARMONY_CONTENT_MODE
      },
      hooksModule: process.env.CODEX_PROXY_HOOK_MODULE || null,
      profiles: profilesConfig ? { file: PROFILES_FILE, default: profilesConfig.default, names: Object.keys(profilesConfig.profiles) } : null,
      stats
    });
  } catch (error) {
    return c.json({
      status: "degraded",
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      upstream: `${UPSTREAM_ORIGIN}${UPSTREAM_BASE_PATH}`,
      auth: {
        path: getAuthPath(),
        error: error instanceof Error ? error.message : String(error)
      },
      thinkingLog: THINKING_LOG_PATH,
      rawEventLog: {
        enabled: RAW_EVENT_LOG_ENABLED,
        path: RAW_EVENT_LOG_PATH
      },
      requestLog: {
        enabled: REQUEST_LOG_ENABLED,
        path: REQUEST_LOG_PATH
      },
      apiJsonLog: {
        enabled: API_JSON_LOG_ENABLED,
        path: API_JSON_LOG_PATH
      },
      harmonyLog: {
        enabled: HARMONY_LOG_ENABLED,
        path: HARMONY_LOG_PATH,
        contentMode: HARMONY_CONTENT_MODE
      },
      hooksModule: process.env.CODEX_PROXY_HOOK_MODULE || null,
      profiles: profilesConfig ? { file: PROFILES_FILE, default: profilesConfig.default, names: Object.keys(profilesConfig.profiles) } : null,
      stats
    }, 503);
  }
});
app.get("/debug/events", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 100, 50000);
  const events = readNdjsonTail(RAW_EVENT_LOG_PATH, limit);
  const filters = {
    requestId: c.req.query("requestId"),
    sessionId: c.req.query("sessionId"),
    type: c.req.query("type")
  };
  const filteredEvents = filterLogEntries(events, filters);
  return c.json({
    enabled: RAW_EVENT_LOG_ENABLED,
    path: RAW_EVENT_LOG_PATH,
    filters,
    count: filteredEvents.length,
    eventsRead: events.length,
    events: filteredEvents
  });
});
app.get("/debug/requests", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 100, 50000);
  const requests = readNdjsonTail(REQUEST_LOG_PATH, limit);
  return c.json({
    enabled: REQUEST_LOG_ENABLED,
    path: REQUEST_LOG_PATH,
    count: requests.length,
    requests
  });
});
app.get("/debug/transcript", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 5000, 50000);
  const events = readNdjsonTail(RAW_EVENT_LOG_PATH, limit);
  const filters = {
    requestId: c.req.query("requestId"),
    sessionId: c.req.query("sessionId"),
    type: c.req.query("type")
  };
  const filteredEvents = filterLogEntries(events, filters);
  return c.json({
    rawEventLog: {
      enabled: RAW_EVENT_LOG_ENABLED,
      path: RAW_EVENT_LOG_PATH,
      eventsRead: events.length,
      eventsUsed: filteredEvents.length,
      filters
    },
    ...buildTranscript(filteredEvents)
  });
});
app.get("/debug/api-json", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 100, 50000);
  const records = readNdjsonTail(API_JSON_LOG_PATH, limit);
  return c.json({
    enabled: API_JSON_LOG_ENABLED,
    path: API_JSON_LOG_PATH,
    count: records.length,
    records
  });
});
app.get("/debug/harmony", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 500, 1e5);
  const records = readNdjsonTail(HARMONY_LOG_PATH, limit);
  const filters = {
    requestId: c.req.query("requestId"),
    sessionId: c.req.query("sessionId"),
    phase: c.req.query("phase")
  };
  const filtered = records.filter((r) => {
    if (filters.requestId && r.requestId !== filters.requestId)
      return false;
    if (filters.sessionId && r.sessionId !== filters.sessionId)
      return false;
    if (filters.phase && r.phase !== filters.phase)
      return false;
    return true;
  });
  return c.json({
    enabled: HARMONY_LOG_ENABLED,
    path: HARMONY_LOG_PATH,
    filters,
    count: filtered.length,
    recordsRead: records.length,
    records: filtered
  });
});
app.get("/debug/tiers", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 5000, 1e5);
  const sessionFilter = c.req.query("session");
  const records = readNdjsonTail(HARMONY_LOG_PATH, limit);
  const totals = {};
  const byHash = {};
  let inputItemCount = 0;
  let scopedRequests = 0;
  for (const r of records) {
    if (sessionFilter && r.sessionId !== sessionFilter)
      continue;
    if (r.phase === "request.input_item") {
      inputItemCount += 1;
      const tier = typeof r.tier === "string" ? r.tier : "unknown";
      const bucket = totals[tier] || { messages: 0, bytes: 0 };
      bucket.messages += 1;
      bucket.bytes += typeof r.byteLen === "number" ? r.byteLen : 0;
      totals[tier] = bucket;
      if (typeof r.contentHash === "string") {
        const key = r.contentHash;
        const entry = byHash[key] || { hash: key, tier, count: 0, byteLen: typeof r.byteLen === "number" ? r.byteLen : 0, firstAt: null, lastAt: null };
        entry.count += 1;
        entry.lastAt = r.at || entry.lastAt;
        if (!entry.firstAt)
          entry.firstAt = r.at || null;
        byHash[key] = entry;
      }
    }
    if (r.phase === "request.tier_summary") {
      scopedRequests += 1;
    }
  }
  const repeatedDeveloper = Object.values(byHash).filter((e) => e.tier === "developer" && e.count > 1).sort((a, b) => b.count - a.count).slice(0, 50);
  return c.json({
    sessionFilter: sessionFilter || null,
    inputItemCount,
    requestsObserved: scopedRequests,
    tiers: totals,
    repeatedDeveloperHashes: repeatedDeveloper,
    uniqueContentHashes: Object.keys(byHash).length
  });
});
app.get("/debug/developer/diff", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 5000, 1e5);
  const sessionFilter = c.req.query("session");
  const records = readNdjsonTail(HARMONY_LOG_PATH, limit);
  const seenHashes = new Set;
  const sequence = [];
  for (const r of records) {
    if (r.phase !== "request.input_item")
      continue;
    if (r.tier !== "developer")
      continue;
    if (sessionFilter && r.sessionId !== sessionFilter)
      continue;
    if (typeof r.contentHash !== "string")
      continue;
    if (seenHashes.has(r.contentHash))
      continue;
    seenHashes.add(r.contentHash);
    sequence.push({
      at: r.at,
      requestId: r.requestId,
      sessionId: r.sessionId ?? null,
      index: typeof r.index === "number" ? r.index : -1,
      contentHash: r.contentHash,
      byteLen: typeof r.byteLen === "number" ? r.byteLen : 0
    });
  }
  return c.json({
    sessionFilter: sessionFilter || null,
    uniqueDeveloperMessages: sequence.length,
    sequence,
    note: "Each entry is the first appearance of a distinct developer-tier content hash. To see full content, set CODEX_PROXY_HARMONY_CONTENT=full and re-run; then query /debug/harmony with the requestId."
  });
});
app.get("/debug/permissions", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 5000, 1e5);
  const sessionFilter = c.req.query("session");
  const records = readNdjsonTail(HARMONY_LOG_PATH, limit);
  const bySession = {};
  const all = [];
  for (const r of records) {
    if (r.phase !== "request.permissions_claim")
      continue;
    if (sessionFilter && r.sessionId !== sessionFilter)
      continue;
    const sess = r.sessionId || "unknown";
    const entry = {
      at: r.at,
      requestId: r.requestId,
      sandboxMode: r.sandboxMode ?? null,
      networkAccess: r.networkAccess ?? null,
      approvalPolicy: r.approvalPolicy ?? null,
      rawHash: r.rawHash ?? null
    };
    bySession[sess] = bySession[sess] || [];
    bySession[sess].push(entry);
    all.push({ sessionId: r.sessionId ?? null, ...entry });
  }
  const latest = {};
  for (const [sess, entries] of Object.entries(bySession)) {
    latest[sess] = entries[entries.length - 1];
  }
  return c.json({
    sessionFilter: sessionFilter || null,
    count: all.length,
    latestBySession: latest,
    history: all
  });
});
app.get("/debug/tools/catalog", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 1000, 50000);
  const sessionFilter = c.req.query("session");
  const records = readNdjsonTail(HARMONY_LOG_PATH, limit);
  let latest = null;
  for (let i = records.length - 1;i >= 0; i -= 1) {
    const r = records[i];
    if (r.phase !== "request.tier_summary")
      continue;
    if (sessionFilter && r.sessionId !== sessionFilter)
      continue;
    latest = r;
    break;
  }
  return c.json({
    sessionFilter: sessionFilter || null,
    latest: latest ? {
      at: latest.at,
      requestId: latest.requestId,
      sessionId: latest.sessionId ?? null,
      toolCount: latest.toolCount ?? 0,
      toolByType: latest.toolByType ?? {},
      toolNames: latest.toolNames ?? [],
      toolChoice: latest.toolChoice ?? null,
      parallelToolCalls: latest.parallelToolCalls ?? null,
      reasoningEffort: latest.reasoningEffort ?? null,
      reasoningSummary: latest.reasoningSummary ?? null,
      promptCacheKey: latest.promptCacheKey ?? null,
      include: latest.include ?? null,
      textVerbosity: latest.textVerbosity ?? null,
      textFormatType: latest.textFormatType ?? null,
      store: latest.store ?? null,
      stream: latest.stream ?? null,
      clientInstallationId: latest.clientInstallationId ?? null,
      instructionsLen: latest.instructionsLen ?? null,
      instructionsHash: latest.instructionsHash ?? null,
      inputTiers: latest.inputTiers ?? {}
    } : null
  });
});
function buildAnalysisByRequest(records, filter) {
  const byReq = new Map;
  for (const r of records) {
    if (filter.sessionId && r.sessionId !== filter.sessionId)
      continue;
    const rid = r.requestId;
    if (!rid)
      continue;
    let entry = byReq.get(rid);
    if (!entry) {
      entry = { requestId: rid, sessionId: r.sessionId ?? null, firstAt: null, lastAt: null, analysis: [], final: [], model: null, metadata: null, tokens: { input: null, output: null }, encryptedCount: 0 };
      byReq.set(rid, entry);
    }
    if (r.at) {
      if (!entry.firstAt)
        entry.firstAt = r.at;
      entry.lastAt = r.at;
    }
    if (r.phase === "response.channel_chunk" && r.channel === "analysis") {
      const s = r.content ?? r.contentHead ?? "";
      if (s)
        entry.analysis.push(s);
    }
    if (r.phase === "response.channel_chunk" && r.channel === "final") {
      const s = r.content ?? r.contentHead ?? "";
      if (s)
        entry.final.push(s);
    }
    if (r.phase === "response.completed") {
      entry.model = r.model || entry.model;
      entry.tokens.input = r.inputTokens ?? entry.tokens.input;
      entry.tokens.output = r.outputTokens ?? entry.tokens.output;
      entry.metadata = r.metadata || entry.metadata;
      entry.encryptedCount = r.encryptedReasoningCount ?? entry.encryptedCount;
    }
  }
  return [...byReq.values()].sort((a, b) => (a.firstAt || "").localeCompare(b.firstAt || ""));
}
app.get("/debug/analysis", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 5000, 1e5);
  const sessionFilter = c.req.query("session");
  const format = c.req.query("format") || "json";
  const records = readNdjsonTail(HARMONY_LOG_PATH, limit);
  const turns = buildAnalysisByRequest(records, { sessionId: sessionFilter });
  if (format === "markdown" || format === "md") {
    const lines = [];
    lines.push(`# Analysis dump${sessionFilter ? ` (session ${sessionFilter})` : ""}`);
    lines.push("");
    for (const t of turns) {
      lines.push(`## ${t.firstAt || ""} \xB7 ${t.requestId} \xB7 ${t.model || "?"}`);
      lines.push(`tokens: in=${t.tokens.input ?? "?"} out=${t.tokens.output ?? "?"}  encrypted-reasoning-blocks: ${t.encryptedCount}`);
      if (t.metadata && Object.keys(t.metadata).length > 0) {
        lines.push(`metadata: \`${JSON.stringify(t.metadata)}\``);
      }
      lines.push("");
      const analysis = t.analysis.join("");
      const final = t.final.join("");
      if (analysis) {
        lines.push("### analysis (CoT)");
        lines.push(analysis);
        lines.push("");
      }
      if (final) {
        lines.push("### final");
        lines.push(final);
        lines.push("");
      }
      lines.push("---");
      lines.push("");
    }
    return new Response(lines.join(`
`), { headers: { "content-type": "text/markdown; charset=utf-8" } });
  }
  return c.json({
    sessionFilter: sessionFilter || null,
    turns: turns.map((t) => ({
      requestId: t.requestId,
      sessionId: t.sessionId,
      firstAt: t.firstAt,
      lastAt: t.lastAt,
      model: t.model,
      tokens: t.tokens,
      metadata: t.metadata,
      encryptedReasoningCount: t.encryptedCount,
      analysis: t.analysis.join(""),
      analysisLen: t.analysis.reduce((acc, s) => acc + s.length, 0),
      final: t.final.join(""),
      finalLen: t.final.reduce((acc, s) => acc + s.length, 0)
    })),
    note: "analysis text is the streamed reasoning_summary the model emitted. With CODEX_PROXY_HARMONY_CONTENT=full set on the proxy, this is the COMPLETE plaintext CoT. With default 'head' mode, only the first 256 chars per chunk are stored. Re-start proxy with full mode for verbatim recall."
  });
});
app.get("/debug/encrypted-reasoning", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 5000, 1e5);
  const sessionFilter = c.req.query("session");
  const records = readNdjsonTail(HARMONY_LOG_PATH, limit);
  const items = records.filter((r) => r.phase === "response.encrypted_reasoning").filter((r) => !sessionFilter || r.sessionId === sessionFilter);
  const ivSet = new Set;
  let dupIvCount = 0;
  const ctSizes = [];
  const versions = {};
  const timestamps = [];
  for (const r of items) {
    const f = r.fernet;
    if (!f)
      continue;
    if (typeof f.ivHex === "string") {
      if (ivSet.has(f.ivHex))
        dupIvCount += 1;
      ivSet.add(f.ivHex);
    }
    if (typeof f.ciphertextBytes === "number")
      ctSizes.push(f.ciphertextBytes);
    if (typeof f.version === "number")
      versions[f.version] = (versions[f.version] || 0) + 1;
    if (typeof f.timestamp === "number")
      timestamps.push(f.timestamp);
  }
  ctSizes.sort((a, b) => a - b);
  return c.json({
    sessionFilter: sessionFilter || null,
    count: items.length,
    summary: {
      versions,
      uniqueIvs: ivSet.size,
      duplicateIvs: dupIvCount,
      ivReuseDetected: dupIvCount > 0,
      ciphertextBytes: ctSizes.length > 0 ? { min: ctSizes[0], median: ctSizes[Math.floor(ctSizes.length / 2)], max: ctSizes[ctSizes.length - 1] } : null,
      timestampRange: timestamps.length > 0 ? { min: Math.min(...timestamps), max: Math.max(...timestamps), spanSec: Math.max(...timestamps) - Math.min(...timestamps) } : null
    },
    items: items.slice(-200).map((r) => ({
      at: r.at,
      requestId: r.requestId,
      sessionId: r.sessionId,
      itemId: r.itemId,
      ...r.fernet
    })),
    note: "Fernet structure parsed without decryption. Plaintext requires the 32-byte key, which is server-held and never sent to the client. Verifying HMAC tags requires the same key."
  });
});
app.get("/debug/ratelimits", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 5000, 1e5);
  const sessionFilter = c.req.query("session");
  const records = readNdjsonTail(HARMONY_LOG_PATH, limit);
  const snaps = records.filter((r) => r.phase === "response.rate_limit_snapshot").filter((r) => !sessionFilter || r.sessionId === sessionFilter);
  const latestBySession = {};
  for (const r of snaps) {
    const sess = r.sessionId || "unknown";
    latestBySession[sess] = { at: r.at, requestId: r.requestId, status: r.status, snapshot: r.snapshot };
  }
  const latest = snaps[snaps.length - 1];
  let liveTimers = null;
  if (latest?.snapshot) {
    const s = latest.snapshot;
    const now = Math.floor(Date.now() / 1000);
    liveTimers = {
      capturedAt: latest.at,
      ageSeconds: latest.at ? Math.max(0, now - Math.floor(new Date(latest.at).getTime() / 1000)) : null,
      primaryResetsInSec: s.primary?.resetAt ? Math.max(0, s.primary.resetAt - now) : s.primary?.resetAfterSeconds,
      secondaryResetsInSec: s.secondary?.resetAt ? Math.max(0, s.secondary.resetAt - now) : s.secondary?.resetAfterSeconds
    };
  }
  return c.json({
    sessionFilter: sessionFilter || null,
    count: snaps.length,
    latest: latest ? { at: latest.at, requestId: latest.requestId, sessionId: latest.sessionId, snapshot: latest.snapshot } : null,
    liveTimers,
    latestBySession,
    history: snaps.slice(-100)
  });
});
app.get("/debug/headers", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 5000, 1e5);
  const records = readNdjsonTail(API_JSON_LOG_PATH, limit);
  const headerKeys = new Map;
  let phaseFilter = c.req.query("phase") || "response.headers";
  for (const r of records) {
    if (r.phase !== phaseFilter)
      continue;
    const h = r.headers || {};
    for (const [k, v] of Object.entries(h)) {
      const cur = headerKeys.get(k) || { count: 0, lastValue: "", lastAt: "" };
      cur.count += 1;
      cur.lastValue = String(v).slice(0, 200);
      cur.lastAt = r.at || cur.lastAt;
      headerKeys.set(k, cur);
    }
  }
  const sorted = [...headerKeys.entries()].sort((a, b) => b[1].count - a[1].count).map(([name, info]) => ({ name, ...info }));
  return c.json({
    phaseFilter,
    distinctHeaders: sorted.length,
    headers: sorted
  });
});
app.get("/debug/auth-mode", async (c) => {
  const probe = resolveApiKey(null, null);
  const profilesWithApiKeyOverride = profilesConfig ? Object.entries(profilesConfig.profiles).filter(([, def]) => def.authMode === "api_key" || def.apiKey && def.apiKey.length > 0).map(([name]) => name) : [];
  let oauth = { available: false };
  try {
    const state = await getStoredAuthInfo();
    oauth = {
      available: true,
      accountId: state.accountId,
      organizationId: state.organizationId,
      expiresAt: state.expiresAt > 0 ? new Date(state.expiresAt).toISOString() : null,
      authMode: state.authMode,
      scopes: state.scopes,
      path: getAuthPath()
    };
  } catch (error) {
    oauth = { available: false, error: error instanceof Error ? error.message : String(error) };
  }
  const authFileMode = getAuthFileMode();
  const resolvedDefault = ENV_AUTH_MODE || authFileMode || "oauth";
  return c.json({
    defaultAuthMode: resolvedDefault,
    envAuthMode: ENV_AUTH_MODE,
    authFileMode,
    apiKey: probe ? {
      configured: true,
      source: probe.source,
      sourceDetail: probe.sourceDetail,
      preview: probe.preview,
      length: probe.length,
      loadedAt: probe.loadedAt
    } : {
      configured: false,
      envSet: isApiKeyEnvSet(),
      filePath: getApiKeyFilePath()
    },
    oauth,
    profilesWithApiKeyOverride
  });
});
app.get("/debug/cot", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 5000, 1e5);
  const sessionFilter = c.req.query("session");
  const modelFilter = c.req.query("model");
  const minBytes = Number.parseInt(c.req.query("min_bytes") || "0", 10) || 0;
  const includeFinal = (c.req.query("include_final") || "").toLowerCase() === "true";
  const records = readNdjsonTail(HARMONY_LOG_PATH, limit);
  const byReq = new Map;
  for (const r of records) {
    const rid = r.requestId;
    if (!rid || rid === "-")
      continue;
    if (sessionFilter && r.sessionId !== sessionFilter)
      continue;
    if (modelFilter && r.model !== modelFilter)
      continue;
    let row = byReq.get(rid);
    if (!row) {
      row = {
        requestId: rid,
        sessionId: r.sessionId ?? null,
        path: r.path ?? null,
        model: r.model ?? null,
        firstAt: null,
        lastAt: null,
        analysis: [],
        analysisBytes: 0,
        final: [],
        finalBytes: 0,
        provider: null,
        stopReason: null
      };
      byReq.set(rid, row);
    }
    if (r.at) {
      if (!row.firstAt || r.at < row.firstAt)
        row.firstAt = r.at;
      if (!row.lastAt || r.at > row.lastAt)
        row.lastAt = r.at;
    }
    if (r.phase === "response.channel_chunk") {
      const text = r.content || r.contentHead || "";
      if (r.channel === "analysis" && text) {
        row.analysis.push(text);
        row.analysisBytes += text.length;
      } else if (r.channel === "final" && text && includeFinal) {
        row.final.push(text);
        row.finalBytes += text.length;
      }
      if (r.model && !row.model)
        row.model = r.model;
    } else if (r.phase === "response.envelope_captured" && r.envelope) {
      if (r.envelope.openrouterProvider)
        row.provider = r.envelope.openrouterProvider;
    } else if (r.phase === "response.completed") {
      if (r.stopReason)
        row.stopReason = r.stopReason;
      if (r.model && !row.model)
        row.model = r.model;
    }
  }
  const rows = [...byReq.values()].filter((r) => r.analysisBytes >= minBytes).sort((a, b) => (b.lastAt || "").localeCompare(a.lastAt || ""));
  const totalBytes = rows.reduce((acc, r) => acc + r.analysisBytes, 0);
  return c.json({
    sessionFilter: sessionFilter || null,
    modelFilter: modelFilter || null,
    minBytes,
    includeFinal,
    requestCount: rows.length,
    totalAnalysisBytes: totalBytes,
    rows: rows.slice(0, 100).map((r) => ({
      requestId: r.requestId,
      sessionId: r.sessionId,
      path: r.path,
      model: r.model,
      firstAt: r.firstAt,
      lastAt: r.lastAt,
      stopReason: r.stopReason,
      provider: r.provider,
      analysisBytes: r.analysisBytes,
      finalBytes: r.finalBytes,
      analysis: r.analysis.join(""),
      final: includeFinal ? r.final.join("") : undefined
    }))
  });
});
app.get("/debug/envelopes", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 5000, 1e5);
  const sessionFilter = c.req.query("session");
  const records = readNdjsonTail(HARMONY_LOG_PATH, limit);
  const envs = records.filter((r) => {
    if (r.phase !== "response.envelope_captured")
      return false;
    if (sessionFilter && r.sessionId !== sessionFilter)
      return false;
    return true;
  });
  const tier = new Map;
  const safetyId = new Map;
  const truncation = new Map;
  const reasoningEffort = new Map;
  const verbosity = new Map;
  let storeTrue = 0, storeFalse = 0;
  let parallelTrue = 0, parallelFalse = 0;
  let withModeration = 0;
  let withPreviousResponse = 0;
  let withToolUsage = 0;
  const latestBySession = {};
  const bump = (m, k) => {
    if (k === null || k === undefined)
      return;
    const key = String(k);
    m.set(key, (m.get(key) || 0) + 1);
  };
  for (const r of envs) {
    const e = r.envelope || {};
    bump(tier, e.serviceTier);
    bump(safetyId, e.safetyIdentifier);
    bump(truncation, e.truncation);
    bump(reasoningEffort, e.reasoningEffort);
    bump(verbosity, e.textVerbosity);
    if (e.store === true)
      storeTrue++;
    else if (e.store === false)
      storeFalse++;
    if (e.parallelToolCalls === true)
      parallelTrue++;
    else if (e.parallelToolCalls === false)
      parallelFalse++;
    if (e.moderation)
      withModeration++;
    if (e.previousResponseId)
      withPreviousResponse++;
    if (e.toolUsage)
      withToolUsage++;
    const sess = r.sessionId || "unknown";
    latestBySession[sess] = { at: r.at, requestId: r.requestId, responseId: r.responseId, stopReason: r.stopReason, envelope: e };
  }
  return c.json({
    sessionFilter: sessionFilter || null,
    total: envs.length,
    countsByServiceTier: Object.fromEntries([...tier.entries()].sort((a, b) => b[1] - a[1])),
    countsBySafetyIdentifier: Object.fromEntries([...safetyId.entries()].sort((a, b) => b[1] - a[1])),
    countsByTruncation: Object.fromEntries([...truncation.entries()].sort((a, b) => b[1] - a[1])),
    countsByReasoningEffort: Object.fromEntries([...reasoningEffort.entries()].sort((a, b) => b[1] - a[1])),
    countsByTextVerbosity: Object.fromEntries([...verbosity.entries()].sort((a, b) => b[1] - a[1])),
    storeTrue,
    storeFalse,
    parallelToolCallsTrue: parallelTrue,
    parallelToolCallsFalse: parallelFalse,
    withModeration,
    withPreviousResponseId: withPreviousResponse,
    withToolUsage,
    latestBySession,
    latest: envs.slice(-50).reverse()
  });
});
app.get("/debug/refusals", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 5000, 1e5);
  const sessionFilter = c.req.query("session");
  const divergentOnly = (c.req.query("divergent_only") || "").toLowerCase() === "true";
  const records = readNdjsonTail(HARMONY_LOG_PATH, limit);
  const refusals = records.filter((r) => {
    if (r.phase !== "response.refusal_detected")
      return false;
    if (sessionFilter && r.sessionId !== sessionFilter)
      return false;
    if (divergentOnly && !r.divergence?.divergent)
      return false;
    return true;
  });
  const byPattern = new Map;
  const byReason = new Map;
  let divergentCount = 0;
  for (const r of refusals) {
    for (const p of r.refusal?.patterns || []) {
      byPattern.set(p, (byPattern.get(p) || 0) + 1);
    }
    const reason = r.divergence?.reason || "n/a";
    byReason.set(reason, (byReason.get(reason) || 0) + 1);
    if (r.divergence?.divergent)
      divergentCount++;
  }
  return c.json({
    sessionFilter: sessionFilter || null,
    divergentOnly,
    total: refusals.length,
    divergentCount,
    countsByPattern: Object.fromEntries([...byPattern.entries()].sort((a, b) => b[1] - a[1])),
    countsByDivergenceReason: Object.fromEntries([...byReason.entries()].sort((a, b) => b[1] - a[1])),
    latest: refusals.slice(-50).reverse()
  });
});
app.get("/debug/blocked", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 5000, 1e5);
  const sessionFilter = c.req.query("session");
  const cyberOnly = (c.req.query("cyber_only") || "").toLowerCase() === "true";
  const records = readNdjsonTail(HARMONY_LOG_PATH, limit);
  const errors = records.filter((r) => {
    if (r.phase !== "response.error_event" && r.phase !== "response.cyber_policy_blocked")
      return false;
    if (sessionFilter && r.sessionId !== sessionFilter)
      return false;
    if (cyberOnly && !r.cyberPolicy && r.phase !== "response.cyber_policy_blocked")
      return false;
    return true;
  });
  const byCode = new Map;
  const bySession = new Map;
  let cyberCount = 0;
  for (const r of errors) {
    if (r.phase === "response.error_event") {
      const code = r.code || "unknown";
      byCode.set(code, (byCode.get(code) || 0) + 1);
    }
    const sess = r.sessionId || "unknown";
    bySession.set(sess, (bySession.get(sess) || 0) + 1);
    if (r.phase === "response.cyber_policy_blocked" || r.cyberPolicy)
      cyberCount++;
  }
  return c.json({
    sessionFilter: sessionFilter || null,
    cyberOnly,
    total: errors.length,
    cyberPolicyBlocks: cyberCount,
    countsByCode: Object.fromEntries([...byCode.entries()].sort((a, b) => b[1] - a[1])),
    countsBySession: Object.fromEntries([...bySession.entries()].sort((a, b) => b[1] - a[1])),
    latest: errors.slice(-50).reverse()
  });
});
app.get("/debug/injections", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 5000, 1e5);
  const sessionFilter = c.req.query("session");
  const minSeverity = c.req.query("severity");
  const records = readNdjsonTail(HARMONY_LOG_PATH, limit);
  const SEV_RANK = { low: 1, medium: 2, high: 3, critical: 4 };
  const minRank = minSeverity ? SEV_RANK[minSeverity] || 0 : 0;
  const detections = records.filter((r) => {
    if (r.phase !== "request.injection_detected")
      return false;
    if (sessionFilter && r.sessionId !== sessionFilter)
      return false;
    if (minRank && (SEV_RANK[r.severity] || 0) < minRank)
      return false;
    return true;
  });
  const byRule = {};
  const bySeverity = {};
  const bySession = {};
  for (const r of detections) {
    byRule[r.rule] = (byRule[r.rule] || 0) + 1;
    bySeverity[r.severity] = (bySeverity[r.severity] || 0) + 1;
    const s = r.sessionId || "unknown";
    bySession[s] = (bySession[s] || 0) + 1;
  }
  return c.json({
    sessionFilter: sessionFilter || null,
    minSeverity: minSeverity || null,
    count: detections.length,
    byRule,
    bySeverity,
    bySession,
    recent: detections.slice(-200)
  });
});
app.get("/debug/profiles", async (c) => {
  if (!profilesConfig) {
    return c.json({ enabled: false, message: "CODEX_PROXY_PROFILES_FILE not set" });
  }
  return c.json({
    enabled: true,
    file: PROFILES_FILE,
    default: profilesConfig.default,
    identifyBy: profilesConfig.identifyBy,
    profiles: Object.fromEntries(Object.entries(profilesConfig.profiles).map(([n, def]) => [n, summarizeProfile(n, def)]))
  });
});
app.get("/debug/profiles/check", async (c) => {
  if (!profilesConfig)
    return c.json({ enabled: false }, 404);
  const headers = {};
  for (const [k, v] of Object.entries(c.req.query())) {
    if (k.startsWith("header.") && typeof v === "string") {
      headers[k.slice("header.".length).toLowerCase()] = v;
    }
  }
  const remoteIp = c.req.query("remote") || null;
  const profile = identifyProfile(profilesConfig, { headers, remoteIp });
  return c.json({
    headersConsidered: headers,
    remoteIp,
    resolved: {
      name: profile.name,
      matchedBy: profile.matchedBy,
      summary: summarizeProfile(profile.name, profile.def)
    }
  });
});
app.get("/debug/profiles/:name", async (c) => {
  if (!profilesConfig)
    return c.json({ enabled: false }, 404);
  const name = c.req.param("name");
  const def = profilesConfig.profiles[name];
  if (!def)
    return c.json({ error: "not_found", name }, 404);
  return c.json({ name, summary: summarizeProfile(name, def), full: def });
});
app.get("/debug/profiles/:name/activity", async (c) => {
  if (!profilesConfig)
    return c.json({ enabled: false }, 404);
  const name = c.req.param("name");
  if (!profilesConfig.profiles[name])
    return c.json({ error: "not_found", name }, 404);
  const limit = parseLimit(c.req.query("limit"), 5000, 1e5);
  const records = readNdjsonTail(HARMONY_LOG_PATH, limit);
  const filtered = records.filter((r) => (r.phase === "request.profile_applied" || r.phase === "request.profile_rejected" || r.phase === "request.profile_rate_limited" || r.phase === "response.profile_channel_dropped") && r.profile === name);
  const summary = {
    applied: 0,
    rejected: 0,
    rateLimited: 0,
    channelsDropped: 0,
    demotedTotal: 0,
    toolsRemovedTotal: 0
  };
  for (const r of filtered) {
    if (r.phase === "request.profile_applied") {
      summary.applied += 1;
      summary.demotedTotal += typeof r.demoted === "number" ? r.demoted : 0;
      summary.toolsRemovedTotal += Array.isArray(r.toolsRemoved) ? r.toolsRemoved.length : 0;
    } else if (r.phase === "request.profile_rejected") {
      summary.rejected += 1;
    } else if (r.phase === "request.profile_rate_limited") {
      summary.rateLimited += 1;
    } else if (r.phase === "response.profile_channel_dropped") {
      summary.channelsDropped += 1;
    }
  }
  return c.json({
    profile: name,
    count: filtered.length,
    summary,
    recent: filtered.slice(-100)
  });
});
app.get("/debug/channels/live", async (c) => {
  const channelsParam = (c.req.query("channels") || "final,analysis,commentary").toLowerCase();
  const wanted = new Set(channelsParam.split(",").map((s) => s.trim()).filter(Boolean));
  const sessionFilter = c.req.query("session");
  let lastSize = 0;
  if (existsSync(HARMONY_LOG_PATH)) {
    try {
      lastSize = readFileSync3(HARMONY_LOG_PATH, "utf8").length;
    } catch {
      lastSize = 0;
    }
  }
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder;
      controller.enqueue(enc.encode(`: live channel feed channels=${[...wanted].join(",")}

`));
      const interval = setInterval(() => {
        try {
          if (!existsSync(HARMONY_LOG_PATH))
            return;
          const content = readFileSync3(HARMONY_LOG_PATH, "utf8");
          if (content.length <= lastSize)
            return;
          const fresh = content.slice(lastSize);
          lastSize = content.length;
          for (const line of fresh.split(`
`)) {
            if (!line)
              continue;
            let r;
            try {
              r = JSON.parse(line);
            } catch {
              continue;
            }
            if (r.phase !== "response.channel_chunk" && r.phase !== "response.tool_call.delta" && r.phase !== "response.tool_call.done")
              continue;
            if (sessionFilter && r.sessionId !== sessionFilter)
              continue;
            const ch = typeof r.channel === "string" ? r.channel : "";
            if (!wanted.has(ch))
              continue;
            controller.enqueue(enc.encode(`event: ${r.phase}
data: ${JSON.stringify(r)}

`));
          }
        } catch (error) {}
      }, 250);
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(enc.encode(`: keepalive ${new Date().toISOString()}

`));
        } catch {}
      }, 15000);
      const cleanup = () => {
        clearInterval(interval);
        clearInterval(heartbeat);
      };
      c.req.raw.signal?.addEventListener?.("abort", cleanup);
    }
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    }
  });
});
app.all("*", async (c) => {
  stats.totalRequests += 1;
  stats.activeRequests += 1;
  stats.lastRequestAt = Date.now();
  const requestId = `${Date.now().toString(36)}-${stats.totalRequests.toString(36)}`;
  const sourceUrl = new URL(c.req.url);
  if (isWebSocketUpgrade(c.req.raw.headers)) {
    stats.activeRequests -= 1;
    console.log(`[proxy] ${c.req.method} ${c.req.path} websocket=unsupported`);
    return new Response("WebSocket transport is not supported by codex-proxy. Falling back to HTTP is expected.", {
      status: 426,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        connection: "close"
      }
    });
  }
  const rawBody = hasBody(c.req.method) ? await c.req.raw.arrayBuffer() : undefined;
  let requestBody = decodeRequestBody(c.req.raw.headers, rawBody);
  apiJsonLog({
    phase: "request.received",
    requestId,
    method: c.req.method,
    path: sourceUrl.pathname,
    search: sourceUrl.search,
    headers: headersForLog(c.req.raw.headers),
    body: bodyForLog(c.req.raw.headers, requestBody)
  });
  let identifiedProfile = null;
  if (profilesConfig) {
    const headersFlat = {};
    c.req.raw.headers.forEach((v, k) => {
      headersFlat[k.toLowerCase()] = v;
    });
    const remoteIp = c.req.raw.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
    identifiedProfile = identifyProfile(profilesConfig, { headers: headersFlat, remoteIp });
    requestProfileMap.set(requestId, identifiedProfile);
    const rate = checkRateLimit(rateLimitStore, identifiedProfile.name, identifiedProfile.def.rateLimit);
    if (!rate.allowed) {
      stats.activeRequests -= 1;
      harmonyEventLog({
        phase: "request.profile_rate_limited",
        requestId,
        profile: identifiedProfile.name,
        matchedBy: identifiedProfile.matchedBy,
        resetIn: rate.resetIn
      });
      return c.json({
        error: "rate_limited",
        profile: identifiedProfile.name,
        message: `profile ${identifiedProfile.name} exceeded rate limit (${identifiedProfile.def.rateLimit})`,
        resetInMs: rate.resetIn
      }, 429);
    }
    if (hasBody(c.req.method)) {
      const preParsed = parseJsonBody(c.req.raw.headers, requestBody);
      if (preParsed) {
        try {
          const result = applyProfileGates(preParsed, identifiedProfile);
          requestBody = encoder.encode(JSON.stringify(result.body));
          harmonyEventLog({
            phase: "request.profile_applied",
            requestId,
            profile: identifiedProfile.name,
            matchedBy: identifiedProfile.matchedBy,
            demoted: result.demoted,
            toolsRemoved: result.toolsRemoved,
            contentTruncatedBytes: result.contentTruncated,
            prefixInjected: result.prefixInjected,
            bodyOverridesApplied: result.bodyOverridesApplied,
            instructionsMutation: result.instructionsMutation,
            developerBlocksDropped: result.developerBlocksDropped,
            systemMessageMutation: result.systemMessageMutation,
            toolsStripped: result.toolsStripped,
            toolChoiceForced: result.toolChoiceForced,
            rateRemaining: rate.remaining
          });
        } catch (error) {
          stats.activeRequests -= 1;
          if (error instanceof ProfileError) {
            harmonyEventLog({
              phase: "request.profile_rejected",
              requestId,
              profile: identifiedProfile.name,
              reason: error.reason
            });
            return c.json({ error: "profile_rejected", profile: identifiedProfile.name, message: error.reason }, error.status);
          }
          throw error;
        }
      }
    }
  }
  const upstreamMode = upstreamModeForRequest(sourceUrl, c.req.raw.headers, identifiedProfile);
  const authMode = resolveAuthMode(identifiedProfile);
  let injectedApiKey = null;
  if (authMode === "api_key") {
    injectedApiKey = resolveApiKey(identifiedProfile?.def.apiKey || null, identifiedProfile?.name || null);
    if (!injectedApiKey) {
      stats.activeRequests -= 1;
      harmonyEventLog({
        phase: "request.api_key_missing",
        requestId,
        profile: identifiedProfile?.name || null
      });
      return c.json({
        error: "api_key_missing",
        message: "authMode is api_key but no API key is configured. Set OPENAI_API_KEY or CODEX_PROXY_API_KEY_FILE, or put an apiKey on the profile."
      }, 503);
    }
    harmonyEventLog({
      phase: "request.api_key_resolved",
      requestId,
      profile: identifiedProfile?.name || null,
      source: injectedApiKey.sourceDetail,
      preview: injectedApiKey.preview
    });
  }
  if (upstreamMode === "openai") {
    const prepared2 = prepareRequest(c.req.url, c.req.raw.headers, requestBody, "openai");
    const summary = prepared2.summary;
    const sessionId = prepared2.sessionId;
    const parsedBody = prepared2.parsedBody;
    const finalRequestBody = prepared2.body;
    const headers = buildOpenAIHeaders(c.req.raw.headers, injectedApiKey?.key || null);
    const upstreamUrl = buildOpenAIUpstreamUrl(c.req.url);
    const upstreamParsedUrl = new URL(upstreamUrl);
    requestLog(requestId, c.req.method, c.req.url, c.req.raw.headers, prepared2);
    if (parsedBody) {
      const inspection = inspectInput(parsedBody);
      emitInputObservability(requestId, sessionId, sourceUrl.pathname, inspection);
    }
    console.log(`[proxy] ${c.req.method} ${c.req.path} upstream=openai model=${summary.model} stream=${summary.stream} session=${sessionId || "-"}`);
    try {
      apiJsonLog({
        phase: "request.forwarded",
        requestId,
        method: c.req.method,
        path: sourceUrl.pathname,
        upstreamMode,
        upstreamPath: upstreamParsedUrl.pathname,
        upstreamSearch: upstreamParsedUrl.search,
        model: summary.model,
        stream: summary.stream,
        sessionId,
        headers: headersForLog(headers),
        body: bodyForLog(c.req.raw.headers, finalRequestBody)
      });
      const init = {
        method: c.req.method,
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      };
      if (finalRequestBody) {
        init.body = finalRequestBody;
        init.duplex = "half";
      }
      const upstream = await fetch(upstreamUrl, init);
      const responseHeaders = stripResponseHeaders(upstream.headers);
      const isSse = summary.stream || responseHeaders.get("content-type")?.includes("text/event-stream") || false;
      apiJsonLog({
        phase: "response.headers",
        requestId,
        path: sourceUrl.pathname,
        upstreamMode,
        upstreamPath: upstreamParsedUrl.pathname,
        model: summary.model,
        stream: isSse,
        sessionId,
        status: upstream.status,
        statusText: upstream.statusText,
        headers: headersForLog(upstream.headers)
      });
      if (!upstream.ok) {
        const preview = await upstream.clone().text();
        console.error(`[proxy] upstream ${upstream.status} ${upstreamUrl}: ${preview.slice(0, 400)}`);
        if (DEBUG_REQUESTS) {
          console.error(`[proxy] request headers ${JSON.stringify(headerPreview(c.req.raw.headers))}`);
          const requestPreview = bodyPreview(c.req.raw.headers, finalRequestBody);
          if (requestPreview) {
            console.error(`[proxy] request preview ${requestPreview}`);
          }
        }
      }
      return new Response(isSse && upstream.body ? interceptStream(upstream.body, summary.model, {
        requestId,
        path: c.req.path,
        sessionId
      }) : upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[proxy] ${c.req.method} ${c.req.path} upstream=openai failed: ${message}`);
      return c.json({ error: "proxy_error", message }, 502);
    } finally {
      stats.activeRequests -= 1;
      requestProfileMap.delete(requestId);
    }
  }
  if (hooks.onRequest) {
    const preParsed = parseJsonBody(c.req.raw.headers, requestBody);
    if (preParsed) {
      try {
        const sessionIdEarly = extractSessionId(new URL(c.req.url), c.req.raw.headers, preParsed);
        const result = await hooks.onRequest(preParsed, {
          path: sourceUrl.pathname,
          method: c.req.method,
          sessionId: sessionIdEarly
        });
        if (result && result !== preParsed) {
          requestBody = encoder.encode(JSON.stringify(result));
          harmonyEventLog({
            phase: "request.hook_mutated",
            requestId,
            sessionId: sessionIdEarly,
            path: sourceUrl.pathname
          });
        }
      } catch (error) {
        console.error(`[proxy] onRequest hook failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const prepared = prepareRequest(c.req.url, c.req.raw.headers, requestBody);
  requestLog(requestId, c.req.method, c.req.url, c.req.raw.headers, prepared);
  if (prepared.parsedBody) {
    const inspection = inspectInput(prepared.parsedBody);
    emitInputObservability(requestId, prepared.sessionId, sourceUrl.pathname, inspection);
  }
  console.log(`[proxy] ${c.req.method} ${c.req.path} model=${prepared.summary.model} stream=${prepared.summary.stream} session=${prepared.sessionId || "-"}`);
  try {
    const auth = await getAuthState();
    const headers = buildHeaders(c.req.raw.headers, auth.accessToken, auth.accountId, prepared.sessionId);
    const upstreamUrl = buildUpstreamUrl(c.req.url, prepared.sessionId);
    const upstreamParsedUrl = new URL(upstreamUrl);
    apiJsonLog({
      phase: "request.forwarded",
      requestId,
      method: c.req.method,
      path: sourceUrl.pathname,
      upstreamMode,
      upstreamPath: upstreamParsedUrl.pathname,
      upstreamSearch: upstreamParsedUrl.search,
      model: prepared.summary.model,
      stream: prepared.summary.stream,
      sessionId: prepared.sessionId,
      headers: headersForLog(headers),
      body: bodyForLog(c.req.raw.headers, prepared.body)
    });
    const init = {
      method: c.req.method,
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    };
    if (prepared.body) {
      init.body = prepared.body;
      init.duplex = "half";
    }
    let upstream = await fetch(upstreamUrl, init);
    if (upstream.status === 401) {
      const errPreview = await upstream.clone().text();
      if (/token_revoked|invalidated oauth|invalid_grant/i.test(errPreview)) {
        harmonyEventLog({
          phase: "upstream.token_revoked_retry",
          requestId,
          sessionId: prepared.sessionId,
          path: sourceUrl.pathname
        });
        try {
          const fresh = await invalidateAndRefresh();
          const retryHeaders = buildHeaders(c.req.raw.headers, fresh.accessToken, fresh.accountId, prepared.sessionId);
          const retryInit = {
            method: c.req.method,
            headers: retryHeaders,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
          };
          if (prepared.body) {
            retryInit.body = prepared.body;
            retryInit.duplex = "half";
          }
          upstream = await fetch(upstreamUrl, retryInit);
        } catch (err) {
          console.error(`[proxy] token-revoked refresh failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    const responseHeaders = stripResponseHeaders(upstream.headers);
    const isSse = prepared.summary.stream || responseHeaders.get("content-type")?.includes("text/event-stream") || false;
    apiJsonLog({
      phase: "response.headers",
      requestId,
      path: sourceUrl.pathname,
      upstreamPath: upstreamParsedUrl.pathname,
      model: prepared.summary.model,
      stream: isSse,
      sessionId: prepared.sessionId,
      status: upstream.status,
      statusText: upstream.statusText,
      headers: headersForLog(upstream.headers)
    });
    const rateSnapshot = parseRateLimitHeaders(upstream.headers);
    if (rateSnapshot) {
      harmonyEventLog({
        phase: "response.rate_limit_snapshot",
        requestId,
        sessionId: prepared.sessionId,
        path: sourceUrl.pathname,
        status: upstream.status,
        snapshot: rateSnapshot
      });
    }
    if (!isSse && upstream.body) {
      const contentType = responseHeaders.get("content-type") || "";
      if (contentType.includes("json") || contentType.startsWith("text/")) {
        try {
          const responseBody = await upstream.clone().arrayBuffer();
          apiJsonLog({
            phase: "response.body",
            requestId,
            path: sourceUrl.pathname,
            upstreamPath: upstreamParsedUrl.pathname,
            model: prepared.summary.model,
            sessionId: prepared.sessionId,
            status: upstream.status,
            body: bodyForLog(responseHeaders, responseBody)
          });
        } catch (error) {
          apiJsonLog({
            phase: "response.body_error",
            requestId,
            path: sourceUrl.pathname,
            upstreamPath: upstreamParsedUrl.pathname,
            model: prepared.summary.model,
            sessionId: prepared.sessionId,
            status: upstream.status,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
    if (!upstream.ok) {
      const preview = await upstream.clone().text();
      console.error(`[proxy] upstream ${upstream.status} ${upstreamUrl}: ${preview.slice(0, 400)}`);
      if (DEBUG_REQUESTS) {
        console.error(`[proxy] request headers ${JSON.stringify(headerPreview(c.req.raw.headers))}`);
        const requestPreview = bodyPreview(c.req.raw.headers, prepared.body);
        if (requestPreview) {
          console.error(`[proxy] request preview ${requestPreview}`);
        }
      }
    }
    if (DEBUG_REQUESTS && isSse) {
      thinkingLog(`[debug ${formatTime()}] stream detected model=${prepared.summary.model}
`);
    }
    return new Response(isSse && upstream.body ? interceptStream(upstream.body, prepared.summary.model, {
      requestId,
      path: c.req.path,
      sessionId: prepared.sessionId
    }) : upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[proxy] ${c.req.method} ${c.req.path} failed: ${message}`);
    return c.json({ error: "proxy_error", message }, 502);
  } finally {
    stats.activeRequests -= 1;
    requestProfileMap.delete(requestId);
  }
});
async function startServer(options) {
  hooks = await loadHooks();
  if (PROFILES_FILE) {
    try {
      profilesConfig = loadProfilesConfig(PROFILES_FILE);
      const names = Object.keys(profilesConfig.profiles);
      console.log(`[proxy] loaded profiles from ${PROFILES_FILE}: ${names.join(", ")} (default=${profilesConfig.default})`);
    } catch (error) {
      console.error(`[proxy] failed to load profiles from ${PROFILES_FILE}: ${error instanceof Error ? error.message : String(error)}`);
      profilesConfig = null;
    }
  }
  const server = Bun.serve({
    port: options.port,
    hostname: options.host,
    idleTimeout: 255,
    fetch: app.fetch
  });
  console.log(`[proxy] listening on http://${options.host}:${server.port}`);
  return server;
}

// bin/proxy.ts
var parsedPort = Number.parseInt(process.env.CODEX_PROXY_PORT || "3462", 10);
var port = Number.isFinite(parsedPort) ? parsedPort : 3462;
var host = process.env.CODEX_PROXY_HOST || "127.0.0.1";
startServer({ port, host });
