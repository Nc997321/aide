// src/index.ts
import * as readline from "readline";

// node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs
import { createRequire as Gz } from "node:module";
import { execFile as wne } from "child_process";
import { randomUUID as pw } from "crypto";
import { createReadStream as kne, realpathSync as Ene } from "fs";
import { copyFile as Pne, mkdir as aw, readdir as Tne, readFile as hz, rm as Ine, writeFile as yz } from "fs/promises";
import { createRequire as Rne } from "module";
import { homedir as cw, tmpdir as $ne } from "os";
import { dirname as dz, isAbsolute as bz, join as Lt, relative as _z, resolve as _u, sep as fw } from "path";
import { fileURLToPath as One } from "url";
import { setMaxListeners as Yz } from "events";
import { spawn as BH } from "child_process";
import { existsSync as qH } from "fs";
import { createInterface as VH } from "readline";
import { homedir as S1 } from "os";
import { join as x1 } from "path";
import { randomUUID as ZF } from "crypto";
import { join as _E } from "path";
import { AsyncLocalStorage as zF } from "async_hooks";
import { appendFile as LF, copyFile as FF, mkdir as HF, open as mE, readdir as gE, readFile as hE, stat as BF, unlink as qF, writeFile as Sh } from "fs/promises";
import { randomBytes as TF } from "crypto";
import { chmod as IF, copyFile as RF, rename as $F, unlink as vh, writeFile as AF } from "fs/promises";
import { realpathSync as kP } from "fs";
import { cwd as G2 } from "process";
import { randomUUID as Ja } from "crypto";
import { createHash as F2, randomBytes as Ume } from "crypto";
import { appendFile as FP, mkdir as IH, rename as HP, stat as RH, symlink as $H, unlink as Mh } from "fs/promises";
import { dirname as qP, join as zh, resolve as AH } from "path";
import * as Y from "fs";
import { lstat as lH, mkdir as uH, open as dH, readdir as pH, readFile as AP, rename as fH, rmdir as mH, rm as gH, stat as hH, unlink as yH } from "fs/promises";
import { existsSync as XH } from "fs";
import { once as tR } from "events";
import { createWriteStream as C6 } from "fs";
import { execFile as $6 } from "child_process";
import { promisify as A6 } from "util";
import { createHash as MV } from "crypto";
import { homedir as b_e, userInfo as DV } from "os";
import Ne from "node:path";
import rj from "node:os";
import Dx from "node:process";
import { join as qee } from "path";
import { readdir as cRe, readFile as Bee } from "fs/promises";
import { release as pj } from "os";
import { isAbsolute as Wj } from "path";
var Lz = Object.create;
var { getPrototypeOf: Fz, defineProperty: Ag, getOwnPropertyNames: Hz } = Object;
var Bz = Object.prototype.hasOwnProperty;
function qz(e) {
  return this[e];
}
var Vz;
var Zz;
var Og = (e, t, r) => {
  var o = e != null && typeof e === "object";
  if (o) {
    var n = t ? Vz ??= /* @__PURE__ */ new WeakMap() : Zz ??= /* @__PURE__ */ new WeakMap(), i = n.get(e);
    if (i) return i;
  }
  r = e != null ? Lz(Fz(e)) : {};
  let s = t || !e || !e.__esModule ? Ag(r, "default", { value: e, enumerable: true }) : r;
  for (let a of Hz(e)) if (!Bz.call(s, a)) Ag(s, a, { get: qz.bind(e, a), enumerable: true });
  if (o) n.set(e, s);
  return s;
};
var k = (e, t) => () => (t || e((t = { exports: {} }).exports, t), t.exports);
var Wz = (e) => e;
function Kz(e, t) {
  this[e] = Wz.bind(null, t);
}
var kr = (e, t) => {
  for (var r in t) Ag(e, r, { get: t[r], enumerable: true, configurable: true, set: Kz.bind(t, r) });
};
var Ot = Gz(import.meta.url);
var Jz = Symbol.dispose || Symbol.for("Symbol.dispose");
var Xz = Symbol.asyncDispose || Symbol.for("Symbol.asyncDispose");
var _e = (e, t, r) => {
  if (t != null) {
    if (typeof t !== "object" && typeof t !== "function") throw TypeError('Object expected to be assigned to "using" declaration');
    var o;
    if (r) o = t[Xz];
    if (o === void 0) o = t[Jz];
    if (typeof o !== "function") throw TypeError("Object not disposable");
    e.push([r, o, t]);
  } else if (r) e.push([r]);
  return t;
};
var ve = (e, t, r) => {
  var o = typeof SuppressedError === "function" ? SuppressedError : function(s, a, c, u) {
    return u = Error(c), u.name = "SuppressedError", u.error = s, u.suppressed = a, u;
  }, n = (s) => t = r ? new o(s, t, "An error was suppressed during disposal") : (r = true, s), i = (s) => {
    while (s = e.pop()) try {
      var a = s[1] && s[1].call(s[2]);
      if (s[0]) return Promise.resolve(a).then(i, (c) => (n(c), i()));
    } catch (c) {
      n(c);
    }
    if (r) throw t;
  };
  return i();
};
var iT = k((nT) => {
  Object.defineProperty(nT, "__esModule", { value: true });
  nT._globalThis = void 0;
  nT._globalThis = typeof globalThis === "object" ? globalThis : global;
});
var sT = k((yo) => {
  var rB = yo && yo.__createBinding || (Object.create ? function(e, t, r, o) {
    if (o === void 0) o = r;
    Object.defineProperty(e, o, { enumerable: true, get: function() {
      return t[r];
    } });
  } : function(e, t, r, o) {
    if (o === void 0) o = r;
    e[o] = t[r];
  }), nB = yo && yo.__exportStar || function(e, t) {
    for (var r in e) if (r !== "default" && !Object.prototype.hasOwnProperty.call(t, r)) rB(t, e, r);
  };
  Object.defineProperty(yo, "__esModule", { value: true });
  nB(iT(), yo);
});
var aT = k((bo) => {
  var oB = bo && bo.__createBinding || (Object.create ? function(e, t, r, o) {
    if (o === void 0) o = r;
    Object.defineProperty(e, o, { enumerable: true, get: function() {
      return t[r];
    } });
  } : function(e, t, r, o) {
    if (o === void 0) o = r;
    e[o] = t[r];
  }), iB = bo && bo.__exportStar || function(e, t) {
    for (var r in e) if (r !== "default" && !Object.prototype.hasOwnProperty.call(t, r)) oB(t, e, r);
  };
  Object.defineProperty(bo, "__esModule", { value: true });
  iB(sT(), bo);
});
var Zh = k((cT) => {
  Object.defineProperty(cT, "__esModule", { value: true });
  cT.VERSION = void 0;
  cT.VERSION = "1.9.0";
});
var mT = k((pT) => {
  Object.defineProperty(pT, "__esModule", { value: true });
  pT.isCompatible = pT._makeCompatibilityCheck = void 0;
  var sB = Zh(), uT = /^(\d+)\.(\d+)\.(\d+)(-(.+))?$/;
  function dT(e) {
    let t = /* @__PURE__ */ new Set([e]), r = /* @__PURE__ */ new Set(), o = e.match(uT);
    if (!o) return () => false;
    let n = { major: +o[1], minor: +o[2], patch: +o[3], prerelease: o[4] };
    if (n.prerelease != null) return function(c) {
      return c === e;
    };
    function i(a) {
      return r.add(a), false;
    }
    function s(a) {
      return t.add(a), true;
    }
    return function(c) {
      if (t.has(c)) return true;
      if (r.has(c)) return false;
      let u = c.match(uT);
      if (!u) return i(c);
      let d = { major: +u[1], minor: +u[2], patch: +u[3], prerelease: u[4] };
      if (d.prerelease != null) return i(c);
      if (n.major !== d.major) return i(c);
      if (n.major === 0) {
        if (n.minor === d.minor && n.patch <= d.patch) return s(c);
        return i(c);
      }
      if (n.minor <= d.minor) return s(c);
      return i(c);
    };
  }
  pT._makeCompatibilityCheck = dT;
  pT.isCompatible = dT(sB.VERSION);
});
var _o = k((gT) => {
  Object.defineProperty(gT, "__esModule", { value: true });
  gT.unregisterGlobal = gT.getGlobal = gT.registerGlobal = void 0;
  var cB = aT(), Ci = Zh(), lB = mT(), uB = Ci.VERSION.split(".")[0], Qa = Symbol.for(`opentelemetry.js.api.${uB}`), ec = cB._globalThis;
  function dB(e, t, r, o = false) {
    var n;
    let i = ec[Qa] = (n = ec[Qa]) !== null && n !== void 0 ? n : { version: Ci.VERSION };
    if (!o && i[e]) {
      let s = Error(`@opentelemetry/api: Attempted duplicate registration of API: ${e}`);
      return r.error(s.stack || s.message), false;
    }
    if (i.version !== Ci.VERSION) {
      let s = Error(`@opentelemetry/api: Registration of version v${i.version} for ${e} does not match previously registered API v${Ci.VERSION}`);
      return r.error(s.stack || s.message), false;
    }
    return i[e] = t, r.debug(`@opentelemetry/api: Registered a global for ${e} v${Ci.VERSION}.`), true;
  }
  gT.registerGlobal = dB;
  function pB(e) {
    var t, r;
    let o = (t = ec[Qa]) === null || t === void 0 ? void 0 : t.version;
    if (!o || !(0, lB.isCompatible)(o)) return;
    return (r = ec[Qa]) === null || r === void 0 ? void 0 : r[e];
  }
  gT.getGlobal = pB;
  function fB(e, t) {
    t.debug(`@opentelemetry/api: Unregistering a global for ${e} v${Ci.VERSION}.`);
    let r = ec[Qa];
    if (r) delete r[e];
  }
  gT.unregisterGlobal = fB;
});
var vT = k((bT) => {
  Object.defineProperty(bT, "__esModule", { value: true });
  bT.DiagComponentLogger = void 0;
  var hB = _o();
  class yT {
    constructor(e) {
      this._namespace = e.namespace || "DiagComponentLogger";
    }
    debug(...e) {
      return tc("debug", this._namespace, e);
    }
    error(...e) {
      return tc("error", this._namespace, e);
    }
    info(...e) {
      return tc("info", this._namespace, e);
    }
    warn(...e) {
      return tc("warn", this._namespace, e);
    }
    verbose(...e) {
      return tc("verbose", this._namespace, e);
    }
  }
  bT.DiagComponentLogger = yT;
  function tc(e, t, r) {
    let o = (0, hB.getGlobal)("diag");
    if (!o) return;
    return r.unshift(t), o[e](...r);
  }
});
var Id = k((ST) => {
  Object.defineProperty(ST, "__esModule", { value: true });
  ST.DiagLogLevel = void 0;
  var yB;
  (function(e) {
    e[e.NONE = 0] = "NONE", e[e.ERROR = 30] = "ERROR", e[e.WARN = 50] = "WARN", e[e.INFO = 60] = "INFO", e[e.DEBUG = 70] = "DEBUG", e[e.VERBOSE = 80] = "VERBOSE", e[e.ALL = 9999] = "ALL";
  })(yB = ST.DiagLogLevel || (ST.DiagLogLevel = {}));
});
var kT = k((xT) => {
  Object.defineProperty(xT, "__esModule", { value: true });
  xT.createLogLevelDiagLogger = void 0;
  var Br = Id();
  function bB(e, t) {
    if (e < Br.DiagLogLevel.NONE) e = Br.DiagLogLevel.NONE;
    else if (e > Br.DiagLogLevel.ALL) e = Br.DiagLogLevel.ALL;
    t = t || {};
    function r(o, n) {
      let i = t[o];
      if (typeof i === "function" && e >= n) return i.bind(t);
      return function() {
      };
    }
    return { error: r("error", Br.DiagLogLevel.ERROR), warn: r("warn", Br.DiagLogLevel.WARN), info: r("info", Br.DiagLogLevel.INFO), debug: r("debug", Br.DiagLogLevel.DEBUG), verbose: r("verbose", Br.DiagLogLevel.VERBOSE) };
  }
  xT.createLogLevelDiagLogger = bB;
});
var vo = k((PT) => {
  Object.defineProperty(PT, "__esModule", { value: true });
  PT.DiagAPI = void 0;
  var _B = vT(), vB = kT(), ET = Id(), Rd = _o(), SB = "diag";
  class Kh {
    constructor() {
      function e(o) {
        return function(...n) {
          let i = (0, Rd.getGlobal)("diag");
          if (!i) return;
          return i[o](...n);
        };
      }
      let t = this, r = (o, n = { logLevel: ET.DiagLogLevel.INFO }) => {
        var i, s, a;
        if (o === t) {
          let d = Error("Cannot use diag as the logger for itself. Please use a DiagLogger implementation like ConsoleDiagLogger or a custom implementation");
          return t.error((i = d.stack) !== null && i !== void 0 ? i : d.message), false;
        }
        if (typeof n === "number") n = { logLevel: n };
        let c = (0, Rd.getGlobal)("diag"), u = (0, vB.createLogLevelDiagLogger)((s = n.logLevel) !== null && s !== void 0 ? s : ET.DiagLogLevel.INFO, o);
        if (c && !n.suppressOverrideMessage) {
          let d = (a = Error().stack) !== null && a !== void 0 ? a : "<failed to generate stacktrace>";
          c.warn(`Current logger will be overwritten from ${d}`), u.warn(`Current logger will overwrite one already registered from ${d}`);
        }
        return (0, Rd.registerGlobal)("diag", u, t, true);
      };
      t.setLogger = r, t.disable = () => {
        (0, Rd.unregisterGlobal)(SB, t);
      }, t.createComponentLogger = (o) => new _B.DiagComponentLogger(o), t.verbose = e("verbose"), t.debug = e("debug"), t.info = e("info"), t.warn = e("warn"), t.error = e("error");
    }
    static instance() {
      if (!this._instance) this._instance = new Kh();
      return this._instance;
    }
  }
  PT.DiagAPI = Kh;
});
var $T = k((IT) => {
  Object.defineProperty(IT, "__esModule", { value: true });
  IT.BaggageImpl = void 0;
  class Mi {
    constructor(e) {
      this._entries = e ? new Map(e) : /* @__PURE__ */ new Map();
    }
    getEntry(e) {
      let t = this._entries.get(e);
      if (!t) return;
      return Object.assign({}, t);
    }
    getAllEntries() {
      return Array.from(this._entries.entries()).map(([e, t]) => [e, t]);
    }
    setEntry(e, t) {
      let r = new Mi(this._entries);
      return r._entries.set(e, t), r;
    }
    removeEntry(e) {
      let t = new Mi(this._entries);
      return t._entries.delete(e), t;
    }
    removeEntries(...e) {
      let t = new Mi(this._entries);
      for (let r of e) t._entries.delete(r);
      return t;
    }
    clear() {
      return new Mi();
    }
  }
  IT.BaggageImpl = Mi;
});
var CT = k((AT) => {
  Object.defineProperty(AT, "__esModule", { value: true });
  AT.baggageEntryMetadataSymbol = void 0;
  AT.baggageEntryMetadataSymbol = Symbol("BaggageEntryMetadata");
});
var Gh = k((MT) => {
  Object.defineProperty(MT, "__esModule", { value: true });
  MT.baggageEntryMetadataFromString = MT.createBaggage = void 0;
  var xB = vo(), wB = $T(), kB = CT(), EB = xB.DiagAPI.instance();
  function PB(e = {}) {
    return new wB.BaggageImpl(new Map(Object.entries(e)));
  }
  MT.createBaggage = PB;
  function TB(e) {
    if (typeof e !== "string") EB.error(`Cannot create baggage metadata from unknown type: ${typeof e}`), e = "";
    return { __TYPE__: kB.baggageEntryMetadataSymbol, toString() {
      return e;
    } };
  }
  MT.baggageEntryMetadataFromString = TB;
});
var rc = k((NT) => {
  Object.defineProperty(NT, "__esModule", { value: true });
  NT.ROOT_CONTEXT = NT.createContextKey = void 0;
  function RB(e) {
    return Symbol.for(e);
  }
  NT.createContextKey = RB;
  class $d {
    constructor(e) {
      let t = this;
      t._currentContext = e ? new Map(e) : /* @__PURE__ */ new Map(), t.getValue = (r) => t._currentContext.get(r), t.setValue = (r, o) => {
        let n = new $d(t._currentContext);
        return n._currentContext.set(r, o), n;
      }, t.deleteValue = (r) => {
        let o = new $d(t._currentContext);
        return o._currentContext.delete(r), o;
      };
    }
  }
  NT.ROOT_CONTEXT = new $d();
});
var FT = k((zT) => {
  Object.defineProperty(zT, "__esModule", { value: true });
  zT.DiagConsoleLogger = void 0;
  var Jh = [{ n: "error", c: "error" }, { n: "warn", c: "warn" }, { n: "info", c: "info" }, { n: "debug", c: "debug" }, { n: "verbose", c: "trace" }];
  class UT {
    constructor() {
      function e(t) {
        return function(...r) {
          if (console) {
            let o = console[t];
            if (typeof o !== "function") o = console.log;
            if (typeof o === "function") return o.apply(console, r);
          }
        };
      }
      for (let t = 0; t < Jh.length; t++) this[Jh[t].n] = e(Jh[t].c);
    }
  }
  zT.DiagConsoleLogger = UT;
});
var iy = k((HT) => {
  Object.defineProperty(HT, "__esModule", { value: true });
  HT.createNoopMeter = HT.NOOP_OBSERVABLE_UP_DOWN_COUNTER_METRIC = HT.NOOP_OBSERVABLE_GAUGE_METRIC = HT.NOOP_OBSERVABLE_COUNTER_METRIC = HT.NOOP_UP_DOWN_COUNTER_METRIC = HT.NOOP_HISTOGRAM_METRIC = HT.NOOP_GAUGE_METRIC = HT.NOOP_COUNTER_METRIC = HT.NOOP_METER = HT.NoopObservableUpDownCounterMetric = HT.NoopObservableGaugeMetric = HT.NoopObservableCounterMetric = HT.NoopObservableMetric = HT.NoopHistogramMetric = HT.NoopGaugeMetric = HT.NoopUpDownCounterMetric = HT.NoopCounterMetric = HT.NoopMetric = HT.NoopMeter = void 0;
  class Xh {
    constructor() {
    }
    createGauge(e, t) {
      return HT.NOOP_GAUGE_METRIC;
    }
    createHistogram(e, t) {
      return HT.NOOP_HISTOGRAM_METRIC;
    }
    createCounter(e, t) {
      return HT.NOOP_COUNTER_METRIC;
    }
    createUpDownCounter(e, t) {
      return HT.NOOP_UP_DOWN_COUNTER_METRIC;
    }
    createObservableGauge(e, t) {
      return HT.NOOP_OBSERVABLE_GAUGE_METRIC;
    }
    createObservableCounter(e, t) {
      return HT.NOOP_OBSERVABLE_COUNTER_METRIC;
    }
    createObservableUpDownCounter(e, t) {
      return HT.NOOP_OBSERVABLE_UP_DOWN_COUNTER_METRIC;
    }
    addBatchObservableCallback(e, t) {
    }
    removeBatchObservableCallback(e) {
    }
  }
  HT.NoopMeter = Xh;
  class Di {
  }
  HT.NoopMetric = Di;
  class Yh extends Di {
    add(e, t) {
    }
  }
  HT.NoopCounterMetric = Yh;
  class Qh extends Di {
    add(e, t) {
    }
  }
  HT.NoopUpDownCounterMetric = Qh;
  class ey extends Di {
    record(e, t) {
    }
  }
  HT.NoopGaugeMetric = ey;
  class ty extends Di {
    record(e, t) {
    }
  }
  HT.NoopHistogramMetric = ty;
  class nc {
    addCallback(e) {
    }
    removeCallback(e) {
    }
  }
  HT.NoopObservableMetric = nc;
  class ry extends nc {
  }
  HT.NoopObservableCounterMetric = ry;
  class ny extends nc {
  }
  HT.NoopObservableGaugeMetric = ny;
  class oy extends nc {
  }
  HT.NoopObservableUpDownCounterMetric = oy;
  HT.NOOP_METER = new Xh();
  HT.NOOP_COUNTER_METRIC = new Yh();
  HT.NOOP_GAUGE_METRIC = new ey();
  HT.NOOP_HISTOGRAM_METRIC = new ty();
  HT.NOOP_UP_DOWN_COUNTER_METRIC = new Qh();
  HT.NOOP_OBSERVABLE_COUNTER_METRIC = new ry();
  HT.NOOP_OBSERVABLE_GAUGE_METRIC = new ny();
  HT.NOOP_OBSERVABLE_UP_DOWN_COUNTER_METRIC = new oy();
  function AB() {
    return HT.NOOP_METER;
  }
  HT.createNoopMeter = AB;
});
var QT = k((YT) => {
  Object.defineProperty(YT, "__esModule", { value: true });
  YT.ValueType = void 0;
  var HB;
  (function(e) {
    e[e.INT = 0] = "INT", e[e.DOUBLE = 1] = "DOUBLE";
  })(HB = YT.ValueType || (YT.ValueType = {}));
});
var ay = k((eI) => {
  Object.defineProperty(eI, "__esModule", { value: true });
  eI.defaultTextMapSetter = eI.defaultTextMapGetter = void 0;
  eI.defaultTextMapGetter = { get(e, t) {
    if (e == null) return;
    return e[t];
  }, keys(e) {
    if (e == null) return [];
    return Object.keys(e);
  } };
  eI.defaultTextMapSetter = { set(e, t, r) {
    if (e == null) return;
    e[t] = r;
  } };
});
var iI = k((nI) => {
  Object.defineProperty(nI, "__esModule", { value: true });
  nI.NoopContextManager = void 0;
  var qB = rc();
  class rI {
    active() {
      return qB.ROOT_CONTEXT;
    }
    with(e, t, r, ...o) {
      return t.call(r, ...o);
    }
    bind(e, t) {
      return t;
    }
    enable() {
      return this;
    }
    disable() {
      return this;
    }
  }
  nI.NoopContextManager = rI;
});
var oc = k((aI) => {
  Object.defineProperty(aI, "__esModule", { value: true });
  aI.ContextAPI = void 0;
  var VB = iI(), cy = _o(), sI = vo(), ly = "context", ZB = new VB.NoopContextManager();
  class uy {
    constructor() {
    }
    static getInstance() {
      if (!this._instance) this._instance = new uy();
      return this._instance;
    }
    setGlobalContextManager(e) {
      return (0, cy.registerGlobal)(ly, e, sI.DiagAPI.instance());
    }
    active() {
      return this._getContextManager().active();
    }
    with(e, t, r, ...o) {
      return this._getContextManager().with(e, t, r, ...o);
    }
    bind(e, t) {
      return this._getContextManager().bind(e, t);
    }
    _getContextManager() {
      return (0, cy.getGlobal)(ly) || ZB;
    }
    disable() {
      this._getContextManager().disable(), (0, cy.unregisterGlobal)(ly, sI.DiagAPI.instance());
    }
  }
  aI.ContextAPI = uy;
});
var py = k((lI) => {
  Object.defineProperty(lI, "__esModule", { value: true });
  lI.TraceFlags = void 0;
  var WB;
  (function(e) {
    e[e.NONE = 0] = "NONE", e[e.SAMPLED = 1] = "SAMPLED";
  })(WB = lI.TraceFlags || (lI.TraceFlags = {}));
});
var Ad = k((uI) => {
  Object.defineProperty(uI, "__esModule", { value: true });
  uI.INVALID_SPAN_CONTEXT = uI.INVALID_TRACEID = uI.INVALID_SPANID = void 0;
  var KB = py();
  uI.INVALID_SPANID = "0000000000000000";
  uI.INVALID_TRACEID = "00000000000000000000000000000000";
  uI.INVALID_SPAN_CONTEXT = { traceId: uI.INVALID_TRACEID, spanId: uI.INVALID_SPANID, traceFlags: KB.TraceFlags.NONE };
});
var Od = k((gI) => {
  Object.defineProperty(gI, "__esModule", { value: true });
  gI.NonRecordingSpan = void 0;
  var GB = Ad();
  class mI {
    constructor(e = GB.INVALID_SPAN_CONTEXT) {
      this._spanContext = e;
    }
    spanContext() {
      return this._spanContext;
    }
    setAttribute(e, t) {
      return this;
    }
    setAttributes(e) {
      return this;
    }
    addEvent(e, t) {
      return this;
    }
    addLink(e) {
      return this;
    }
    addLinks(e) {
      return this;
    }
    setStatus(e) {
      return this;
    }
    updateName(e) {
      return this;
    }
    end(e) {
    }
    isRecording() {
      return false;
    }
    recordException(e, t) {
    }
  }
  gI.NonRecordingSpan = mI;
});
var gy = k((bI) => {
  Object.defineProperty(bI, "__esModule", { value: true });
  bI.getSpanContext = bI.setSpanContext = bI.deleteSpan = bI.setSpan = bI.getActiveSpan = bI.getSpan = void 0;
  var JB = rc(), XB = Od(), YB = oc(), fy = (0, JB.createContextKey)("OpenTelemetry Context Key SPAN");
  function my(e) {
    return e.getValue(fy) || void 0;
  }
  bI.getSpan = my;
  function QB() {
    return my(YB.ContextAPI.getInstance().active());
  }
  bI.getActiveSpan = QB;
  function yI(e, t) {
    return e.setValue(fy, t);
  }
  bI.setSpan = yI;
  function eq(e) {
    return e.deleteValue(fy);
  }
  bI.deleteSpan = eq;
  function tq(e, t) {
    return yI(e, new XB.NonRecordingSpan(t));
  }
  bI.setSpanContext = tq;
  function rq(e) {
    var t;
    return (t = my(e)) === null || t === void 0 ? void 0 : t.spanContext();
  }
  bI.getSpanContext = rq;
});
var Cd = k((wI) => {
  Object.defineProperty(wI, "__esModule", { value: true });
  wI.wrapSpanContext = wI.isSpanContextValid = wI.isValidSpanId = wI.isValidTraceId = void 0;
  var vI = Ad(), cq = Od(), lq = /^([0-9a-f]{32})$/i, uq = /^[0-9a-f]{16}$/i;
  function SI(e) {
    return lq.test(e) && e !== vI.INVALID_TRACEID;
  }
  wI.isValidTraceId = SI;
  function xI(e) {
    return uq.test(e) && e !== vI.INVALID_SPANID;
  }
  wI.isValidSpanId = xI;
  function dq(e) {
    return SI(e.traceId) && xI(e.spanId);
  }
  wI.isSpanContextValid = dq;
  function pq(e) {
    return new cq.NonRecordingSpan(e);
  }
  wI.wrapSpanContext = pq;
});
var by = k((TI) => {
  Object.defineProperty(TI, "__esModule", { value: true });
  TI.NoopTracer = void 0;
  var hq = oc(), EI = gy(), hy = Od(), yq = Cd(), yy = hq.ContextAPI.getInstance();
  class PI {
    startSpan(e, t, r = yy.active()) {
      if (Boolean(t === null || t === void 0 ? void 0 : t.root)) return new hy.NonRecordingSpan();
      let n = r && (0, EI.getSpanContext)(r);
      if (bq(n) && (0, yq.isSpanContextValid)(n)) return new hy.NonRecordingSpan(n);
      else return new hy.NonRecordingSpan();
    }
    startActiveSpan(e, t, r, o) {
      let n, i, s;
      if (arguments.length < 2) return;
      else if (arguments.length === 2) s = t;
      else if (arguments.length === 3) n = t, s = r;
      else n = t, i = r, s = o;
      let a = i !== null && i !== void 0 ? i : yy.active(), c = this.startSpan(e, n, a), u = (0, EI.setSpan)(a, c);
      return yy.with(u, s, void 0, c);
    }
  }
  TI.NoopTracer = PI;
  function bq(e) {
    return typeof e === "object" && typeof e.spanId === "string" && typeof e.traceId === "string" && typeof e.traceFlags === "number";
  }
});
var _y = k(($I) => {
  Object.defineProperty($I, "__esModule", { value: true });
  $I.ProxyTracer = void 0;
  var _q = by(), vq = new _q.NoopTracer();
  class RI {
    constructor(e, t, r, o) {
      this._provider = e, this.name = t, this.version = r, this.options = o;
    }
    startSpan(e, t, r) {
      return this._getTracer().startSpan(e, t, r);
    }
    startActiveSpan(e, t, r, o) {
      let n = this._getTracer();
      return Reflect.apply(n.startActiveSpan, n, arguments);
    }
    _getTracer() {
      if (this._delegate) return this._delegate;
      let e = this._provider.getDelegateTracer(this.name, this.version, this.options);
      if (!e) return vq;
      return this._delegate = e, this._delegate;
    }
  }
  $I.ProxyTracer = RI;
});
var DI = k((CI) => {
  Object.defineProperty(CI, "__esModule", { value: true });
  CI.NoopTracerProvider = void 0;
  var Sq = by();
  class OI {
    getTracer(e, t, r) {
      return new Sq.NoopTracer();
    }
  }
  CI.NoopTracerProvider = OI;
});
var vy = k((jI) => {
  Object.defineProperty(jI, "__esModule", { value: true });
  jI.ProxyTracerProvider = void 0;
  var xq = _y(), wq = DI(), kq = new wq.NoopTracerProvider();
  class NI {
    getTracer(e, t, r) {
      var o;
      return (o = this.getDelegateTracer(e, t, r)) !== null && o !== void 0 ? o : new xq.ProxyTracer(this, e, t, r);
    }
    getDelegate() {
      var e;
      return (e = this._delegate) !== null && e !== void 0 ? e : kq;
    }
    setDelegate(e) {
      this._delegate = e;
    }
    getDelegateTracer(e, t, r) {
      var o;
      return (o = this._delegate) === null || o === void 0 ? void 0 : o.getTracer(e, t, r);
    }
  }
  jI.ProxyTracerProvider = NI;
});
var LI = k((zI) => {
  Object.defineProperty(zI, "__esModule", { value: true });
  zI.SamplingDecision = void 0;
  var Eq;
  (function(e) {
    e[e.NOT_RECORD = 0] = "NOT_RECORD", e[e.RECORD = 1] = "RECORD", e[e.RECORD_AND_SAMPLED = 2] = "RECORD_AND_SAMPLED";
  })(Eq = zI.SamplingDecision || (zI.SamplingDecision = {}));
});
var HI = k((FI) => {
  Object.defineProperty(FI, "__esModule", { value: true });
  FI.SpanKind = void 0;
  var Pq;
  (function(e) {
    e[e.INTERNAL = 0] = "INTERNAL", e[e.SERVER = 1] = "SERVER", e[e.CLIENT = 2] = "CLIENT", e[e.PRODUCER = 3] = "PRODUCER", e[e.CONSUMER = 4] = "CONSUMER";
  })(Pq = FI.SpanKind || (FI.SpanKind = {}));
});
var qI = k((BI) => {
  Object.defineProperty(BI, "__esModule", { value: true });
  BI.SpanStatusCode = void 0;
  var Tq;
  (function(e) {
    e[e.UNSET = 0] = "UNSET", e[e.OK = 1] = "OK", e[e.ERROR = 2] = "ERROR";
  })(Tq = BI.SpanStatusCode || (BI.SpanStatusCode = {}));
});
var WI = k((VI) => {
  Object.defineProperty(VI, "__esModule", { value: true });
  VI.validateValue = VI.validateKey = void 0;
  var ky = "[_0-9a-z-*/]", Iq = `[a-z]${ky}{0,255}`, Rq = `[a-z0-9]${ky}{0,240}@[a-z]${ky}{0,13}`, $q = new RegExp(`^(?:${Iq}|${Rq})$`), Aq = /^[ -~]{0,255}[!-~]$/, Oq = /,|=/;
  function Cq(e) {
    return $q.test(e);
  }
  VI.validateKey = Cq;
  function Mq(e) {
    return Aq.test(e) && !Oq.test(e);
  }
  VI.validateValue = Mq;
});
var e0 = k((YI) => {
  Object.defineProperty(YI, "__esModule", { value: true });
  YI.TraceStateImpl = void 0;
  var KI = WI(), GI = 32, Nq = 512, JI = ",", XI = "=";
  class Ey {
    constructor(e) {
      if (this._internalState = /* @__PURE__ */ new Map(), e) this._parse(e);
    }
    set(e, t) {
      let r = this._clone();
      if (r._internalState.has(e)) r._internalState.delete(e);
      return r._internalState.set(e, t), r;
    }
    unset(e) {
      let t = this._clone();
      return t._internalState.delete(e), t;
    }
    get(e) {
      return this._internalState.get(e);
    }
    serialize() {
      return this._keys().reduce((e, t) => (e.push(t + XI + this.get(t)), e), []).join(JI);
    }
    _parse(e) {
      if (e.length > Nq) return;
      if (this._internalState = e.split(JI).reverse().reduce((t, r) => {
        let o = r.trim(), n = o.indexOf(XI);
        if (n !== -1) {
          let i = o.slice(0, n), s = o.slice(n + 1, r.length);
          if ((0, KI.validateKey)(i) && (0, KI.validateValue)(s)) t.set(i, s);
        }
        return t;
      }, /* @__PURE__ */ new Map()), this._internalState.size > GI) this._internalState = new Map(Array.from(this._internalState.entries()).reverse().slice(0, GI));
    }
    _keys() {
      return Array.from(this._internalState.keys()).reverse();
    }
    _clone() {
      let e = new Ey();
      return e._internalState = new Map(this._internalState), e;
    }
  }
  YI.TraceStateImpl = Ey;
});
var n0 = k((t0) => {
  Object.defineProperty(t0, "__esModule", { value: true });
  t0.createTraceState = void 0;
  var jq = e0();
  function Uq(e) {
    return new jq.TraceStateImpl(e);
  }
  t0.createTraceState = Uq;
});
var s0 = k((o0) => {
  Object.defineProperty(o0, "__esModule", { value: true });
  o0.context = void 0;
  var zq = oc();
  o0.context = zq.ContextAPI.getInstance();
});
var l0 = k((a0) => {
  Object.defineProperty(a0, "__esModule", { value: true });
  a0.diag = void 0;
  var Lq = vo();
  a0.diag = Lq.DiagAPI.instance();
});
var p0 = k((u0) => {
  Object.defineProperty(u0, "__esModule", { value: true });
  u0.NOOP_METER_PROVIDER = u0.NoopMeterProvider = void 0;
  var Fq = iy();
  class Py {
    getMeter(e, t, r) {
      return Fq.NOOP_METER;
    }
  }
  u0.NoopMeterProvider = Py;
  u0.NOOP_METER_PROVIDER = new Py();
});
var h0 = k((m0) => {
  Object.defineProperty(m0, "__esModule", { value: true });
  m0.MetricsAPI = void 0;
  var Bq = p0(), Ty = _o(), f0 = vo(), Iy = "metrics";
  class Ry {
    constructor() {
    }
    static getInstance() {
      if (!this._instance) this._instance = new Ry();
      return this._instance;
    }
    setGlobalMeterProvider(e) {
      return (0, Ty.registerGlobal)(Iy, e, f0.DiagAPI.instance());
    }
    getMeterProvider() {
      return (0, Ty.getGlobal)(Iy) || Bq.NOOP_METER_PROVIDER;
    }
    getMeter(e, t, r) {
      return this.getMeterProvider().getMeter(e, t, r);
    }
    disable() {
      (0, Ty.unregisterGlobal)(Iy, f0.DiagAPI.instance());
    }
  }
  m0.MetricsAPI = Ry;
});
var _0 = k((y0) => {
  Object.defineProperty(y0, "__esModule", { value: true });
  y0.metrics = void 0;
  var qq = h0();
  y0.metrics = qq.MetricsAPI.getInstance();
});
var w0 = k((S0) => {
  Object.defineProperty(S0, "__esModule", { value: true });
  S0.NoopTextMapPropagator = void 0;
  class v0 {
    inject(e, t) {
    }
    extract(e, t) {
      return e;
    }
    fields() {
      return [];
    }
  }
  S0.NoopTextMapPropagator = v0;
});
var T0 = k((E0) => {
  Object.defineProperty(E0, "__esModule", { value: true });
  E0.deleteBaggage = E0.setBaggage = E0.getActiveBaggage = E0.getBaggage = void 0;
  var Vq = oc(), Zq = rc(), $y = (0, Zq.createContextKey)("OpenTelemetry Baggage Key");
  function k0(e) {
    return e.getValue($y) || void 0;
  }
  E0.getBaggage = k0;
  function Wq() {
    return k0(Vq.ContextAPI.getInstance().active());
  }
  E0.getActiveBaggage = Wq;
  function Kq(e, t) {
    return e.setValue($y, t);
  }
  E0.setBaggage = Kq;
  function Gq(e) {
    return e.deleteValue($y);
  }
  E0.deleteBaggage = Gq;
});
var O0 = k(($0) => {
  Object.defineProperty($0, "__esModule", { value: true });
  $0.PropagationAPI = void 0;
  var Ay = _o(), Qq = w0(), I0 = ay(), Md = T0(), e6 = Gh(), R0 = vo(), Oy = "propagation", t6 = new Qq.NoopTextMapPropagator();
  class Cy {
    constructor() {
      this.createBaggage = e6.createBaggage, this.getBaggage = Md.getBaggage, this.getActiveBaggage = Md.getActiveBaggage, this.setBaggage = Md.setBaggage, this.deleteBaggage = Md.deleteBaggage;
    }
    static getInstance() {
      if (!this._instance) this._instance = new Cy();
      return this._instance;
    }
    setGlobalPropagator(e) {
      return (0, Ay.registerGlobal)(Oy, e, R0.DiagAPI.instance());
    }
    inject(e, t, r = I0.defaultTextMapSetter) {
      return this._getGlobalPropagator().inject(e, t, r);
    }
    extract(e, t, r = I0.defaultTextMapGetter) {
      return this._getGlobalPropagator().extract(e, t, r);
    }
    fields() {
      return this._getGlobalPropagator().fields();
    }
    disable() {
      (0, Ay.unregisterGlobal)(Oy, R0.DiagAPI.instance());
    }
    _getGlobalPropagator() {
      return (0, Ay.getGlobal)(Oy) || t6;
    }
  }
  $0.PropagationAPI = Cy;
});
var D0 = k((C0) => {
  Object.defineProperty(C0, "__esModule", { value: true });
  C0.propagation = void 0;
  var r6 = O0();
  C0.propagation = r6.PropagationAPI.getInstance();
});
var F0 = k((z0) => {
  Object.defineProperty(z0, "__esModule", { value: true });
  z0.TraceAPI = void 0;
  var My = _o(), N0 = vy(), j0 = Cd(), Ni = gy(), U0 = vo(), Dy = "trace";
  class Ny {
    constructor() {
      this._proxyTracerProvider = new N0.ProxyTracerProvider(), this.wrapSpanContext = j0.wrapSpanContext, this.isSpanContextValid = j0.isSpanContextValid, this.deleteSpan = Ni.deleteSpan, this.getSpan = Ni.getSpan, this.getActiveSpan = Ni.getActiveSpan, this.getSpanContext = Ni.getSpanContext, this.setSpan = Ni.setSpan, this.setSpanContext = Ni.setSpanContext;
    }
    static getInstance() {
      if (!this._instance) this._instance = new Ny();
      return this._instance;
    }
    setGlobalTracerProvider(e) {
      let t = (0, My.registerGlobal)(Dy, this._proxyTracerProvider, U0.DiagAPI.instance());
      if (t) this._proxyTracerProvider.setDelegate(e);
      return t;
    }
    getTracerProvider() {
      return (0, My.getGlobal)(Dy) || this._proxyTracerProvider;
    }
    getTracer(e, t) {
      return this.getTracerProvider().getTracer(e, t);
    }
    disable() {
      (0, My.unregisterGlobal)(Dy, U0.DiagAPI.instance()), this._proxyTracerProvider = new N0.ProxyTracerProvider();
    }
  }
  z0.TraceAPI = Ny;
});
var q0 = k((H0) => {
  Object.defineProperty(H0, "__esModule", { value: true });
  H0.trace = void 0;
  var n6 = F0();
  H0.trace = n6.TraceAPI.getInstance();
});
var Y0 = k((be) => {
  Object.defineProperty(be, "__esModule", { value: true });
  be.trace = be.propagation = be.metrics = be.diag = be.context = be.INVALID_SPAN_CONTEXT = be.INVALID_TRACEID = be.INVALID_SPANID = be.isValidSpanId = be.isValidTraceId = be.isSpanContextValid = be.createTraceState = be.TraceFlags = be.SpanStatusCode = be.SpanKind = be.SamplingDecision = be.ProxyTracerProvider = be.ProxyTracer = be.defaultTextMapSetter = be.defaultTextMapGetter = be.ValueType = be.createNoopMeter = be.DiagLogLevel = be.DiagConsoleLogger = be.ROOT_CONTEXT = be.createContextKey = be.baggageEntryMetadataFromString = void 0;
  var o6 = Gh();
  Object.defineProperty(be, "baggageEntryMetadataFromString", { enumerable: true, get: function() {
    return o6.baggageEntryMetadataFromString;
  } });
  var V0 = rc();
  Object.defineProperty(be, "createContextKey", { enumerable: true, get: function() {
    return V0.createContextKey;
  } });
  Object.defineProperty(be, "ROOT_CONTEXT", { enumerable: true, get: function() {
    return V0.ROOT_CONTEXT;
  } });
  var i6 = FT();
  Object.defineProperty(be, "DiagConsoleLogger", { enumerable: true, get: function() {
    return i6.DiagConsoleLogger;
  } });
  var s6 = Id();
  Object.defineProperty(be, "DiagLogLevel", { enumerable: true, get: function() {
    return s6.DiagLogLevel;
  } });
  var a6 = iy();
  Object.defineProperty(be, "createNoopMeter", { enumerable: true, get: function() {
    return a6.createNoopMeter;
  } });
  var c6 = QT();
  Object.defineProperty(be, "ValueType", { enumerable: true, get: function() {
    return c6.ValueType;
  } });
  var Z0 = ay();
  Object.defineProperty(be, "defaultTextMapGetter", { enumerable: true, get: function() {
    return Z0.defaultTextMapGetter;
  } });
  Object.defineProperty(be, "defaultTextMapSetter", { enumerable: true, get: function() {
    return Z0.defaultTextMapSetter;
  } });
  var l6 = _y();
  Object.defineProperty(be, "ProxyTracer", { enumerable: true, get: function() {
    return l6.ProxyTracer;
  } });
  var u6 = vy();
  Object.defineProperty(be, "ProxyTracerProvider", { enumerable: true, get: function() {
    return u6.ProxyTracerProvider;
  } });
  var d6 = LI();
  Object.defineProperty(be, "SamplingDecision", { enumerable: true, get: function() {
    return d6.SamplingDecision;
  } });
  var p6 = HI();
  Object.defineProperty(be, "SpanKind", { enumerable: true, get: function() {
    return p6.SpanKind;
  } });
  var f6 = qI();
  Object.defineProperty(be, "SpanStatusCode", { enumerable: true, get: function() {
    return f6.SpanStatusCode;
  } });
  var m6 = py();
  Object.defineProperty(be, "TraceFlags", { enumerable: true, get: function() {
    return m6.TraceFlags;
  } });
  var g6 = n0();
  Object.defineProperty(be, "createTraceState", { enumerable: true, get: function() {
    return g6.createTraceState;
  } });
  var jy = Cd();
  Object.defineProperty(be, "isSpanContextValid", { enumerable: true, get: function() {
    return jy.isSpanContextValid;
  } });
  Object.defineProperty(be, "isValidTraceId", { enumerable: true, get: function() {
    return jy.isValidTraceId;
  } });
  Object.defineProperty(be, "isValidSpanId", { enumerable: true, get: function() {
    return jy.isValidSpanId;
  } });
  var Uy = Ad();
  Object.defineProperty(be, "INVALID_SPANID", { enumerable: true, get: function() {
    return Uy.INVALID_SPANID;
  } });
  Object.defineProperty(be, "INVALID_TRACEID", { enumerable: true, get: function() {
    return Uy.INVALID_TRACEID;
  } });
  Object.defineProperty(be, "INVALID_SPAN_CONTEXT", { enumerable: true, get: function() {
    return Uy.INVALID_SPAN_CONTEXT;
  } });
  var W0 = s0();
  Object.defineProperty(be, "context", { enumerable: true, get: function() {
    return W0.context;
  } });
  var K0 = l0();
  Object.defineProperty(be, "diag", { enumerable: true, get: function() {
    return K0.diag;
  } });
  var G0 = _0();
  Object.defineProperty(be, "metrics", { enumerable: true, get: function() {
    return G0.metrics;
  } });
  var J0 = D0();
  Object.defineProperty(be, "propagation", { enumerable: true, get: function() {
    return J0.propagation;
  } });
  var X0 = q0();
  Object.defineProperty(be, "trace", { enumerable: true, get: function() {
    return X0.trace;
  } });
  be.default = { context: W0.context, diag: K0.diag, metrics: G0.metrics, propagation: J0.propagation, trace: X0.trace };
});
var jl = k((nO) => {
  Object.defineProperty(nO, "__esModule", { value: true });
  nO.regexpCode = nO.getEsmExportName = nO.getProperty = nO.safeStringify = nO.stringify = nO.strConcat = nO.addCodeArg = nO.str = nO._ = nO.nil = nO._Code = nO.Name = nO.IDENTIFIER = nO._CodeOrName = void 0;
  class Em {
  }
  nO._CodeOrName = Em;
  nO.IDENTIFIER = /^[a-z$_][a-z$_0-9]*$/i;
  class _s extends Em {
    constructor(e) {
      super();
      if (!nO.IDENTIFIER.test(e)) throw Error("CodeGen: name must be a valid identifier");
      this.str = e;
    }
    toString() {
      return this.str;
    }
    emptyStr() {
      return false;
    }
    get names() {
      return { [this.str]: 1 };
    }
  }
  nO.Name = _s;
  class gr extends Em {
    constructor(e) {
      super();
      this._items = typeof e === "string" ? [e] : e;
    }
    toString() {
      return this.str;
    }
    emptyStr() {
      if (this._items.length > 1) return false;
      let e = this._items[0];
      return e === "" || e === '""';
    }
    get str() {
      var e;
      return (e = this._str) !== null && e !== void 0 ? e : this._str = this._items.reduce((t, r) => `${t}${r}`, "");
    }
    get names() {
      var e;
      return (e = this._names) !== null && e !== void 0 ? e : this._names = this._items.reduce((t, r) => {
        if (r instanceof _s) t[r.str] = (t[r.str] || 0) + 1;
        return t;
      }, {});
    }
  }
  nO._Code = gr;
  nO.nil = new gr("");
  function tO(e, ...t) {
    let r = [e[0]], o = 0;
    while (o < t.length) kS(r, t[o]), r.push(e[++o]);
    return new gr(r);
  }
  nO._ = tO;
  var wS = new gr("+");
  function rO(e, ...t) {
    let r = [Nl(e[0])], o = 0;
    while (o < t.length) r.push(wS), kS(r, t[o]), r.push(wS, Nl(e[++o]));
    return LG(r), new gr(r);
  }
  nO.str = rO;
  function kS(e, t) {
    if (t instanceof gr) e.push(...t._items);
    else if (t instanceof _s) e.push(t);
    else e.push(BG(t));
  }
  nO.addCodeArg = kS;
  function LG(e) {
    let t = 1;
    while (t < e.length - 1) {
      if (e[t] === wS) {
        let r = FG(e[t - 1], e[t + 1]);
        if (r !== void 0) {
          e.splice(t - 1, 3, r);
          continue;
        }
        e[t++] = "+";
      }
      t++;
    }
  }
  function FG(e, t) {
    if (t === '""') return e;
    if (e === '""') return t;
    if (typeof e == "string") {
      if (t instanceof _s || e[e.length - 1] !== '"') return;
      if (typeof t != "string") return `${e.slice(0, -1)}${t}"`;
      if (t[0] === '"') return e.slice(0, -1) + t.slice(1);
      return;
    }
    if (typeof t == "string" && t[0] === '"' && !(e instanceof _s)) return `"${e}${t.slice(1)}`;
    return;
  }
  function HG(e, t) {
    return t.emptyStr() ? e : e.emptyStr() ? t : rO`${e}${t}`;
  }
  nO.strConcat = HG;
  function BG(e) {
    return typeof e == "number" || typeof e == "boolean" || e === null ? e : Nl(Array.isArray(e) ? e.join(",") : e);
  }
  function qG(e) {
    return new gr(Nl(e));
  }
  nO.stringify = qG;
  function Nl(e) {
    return JSON.stringify(e).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  }
  nO.safeStringify = Nl;
  function VG(e) {
    return typeof e == "string" && nO.IDENTIFIER.test(e) ? new gr(`.${e}`) : tO`[${e}]`;
  }
  nO.getProperty = VG;
  function ZG(e) {
    if (typeof e == "string" && nO.IDENTIFIER.test(e)) return new gr(`${e}`);
    throw Error(`CodeGen: invalid export name: ${e}, use explicit $id name mapping`);
  }
  nO.getEsmExportName = ZG;
  function WG(e) {
    return new gr(e.toString());
  }
  nO.regexpCode = WG;
});
var IS = k((aO) => {
  Object.defineProperty(aO, "__esModule", { value: true });
  aO.ValueScope = aO.ValueScopeName = aO.Scope = aO.varKinds = aO.UsedValueState = void 0;
  var Tt = jl();
  class iO extends Error {
    constructor(e) {
      super(`CodeGen: "code" for ${e} not defined`);
      this.value = e.value;
    }
  }
  var Tm;
  (function(e) {
    e[e.Started = 0] = "Started", e[e.Completed = 1] = "Completed";
  })(Tm || (aO.UsedValueState = Tm = {}));
  aO.varKinds = { const: new Tt.Name("const"), let: new Tt.Name("let"), var: new Tt.Name("var") };
  class PS {
    constructor({ prefixes: e, parent: t } = {}) {
      this._names = {}, this._prefixes = e, this._parent = t;
    }
    toName(e) {
      return e instanceof Tt.Name ? e : this.name(e);
    }
    name(e) {
      return new Tt.Name(this._newName(e));
    }
    _newName(e) {
      let t = this._names[e] || this._nameGroup(e);
      return `${e}${t.index++}`;
    }
    _nameGroup(e) {
      var t, r;
      if (((r = (t = this._parent) === null || t === void 0 ? void 0 : t._prefixes) === null || r === void 0 ? void 0 : r.has(e)) || this._prefixes && !this._prefixes.has(e)) throw Error(`CodeGen: prefix "${e}" is not allowed in this scope`);
      return this._names[e] = { prefix: e, index: 0 };
    }
  }
  aO.Scope = PS;
  class TS extends Tt.Name {
    constructor(e, t) {
      super(t);
      this.prefix = e;
    }
    setValue(e, { property: t, itemIndex: r }) {
      this.value = e, this.scopePath = Tt._`.${new Tt.Name(t)}[${r}]`;
    }
  }
  aO.ValueScopeName = TS;
  var sJ = Tt._`\n`;
  class sO extends PS {
    constructor(e) {
      super(e);
      this._values = {}, this._scope = e.scope, this.opts = { ...e, _n: e.lines ? sJ : Tt.nil };
    }
    get() {
      return this._scope;
    }
    name(e) {
      return new TS(e, this._newName(e));
    }
    value(e, t) {
      var r;
      if (t.ref === void 0) throw Error("CodeGen: ref must be passed in value");
      let o = this.toName(e), { prefix: n } = o, i = (r = t.key) !== null && r !== void 0 ? r : t.ref, s = this._values[n];
      if (s) {
        let u = s.get(i);
        if (u) return u;
      } else s = this._values[n] = /* @__PURE__ */ new Map();
      s.set(i, o);
      let a = this._scope[n] || (this._scope[n] = []), c = a.length;
      return a[c] = t.ref, o.setValue(t, { property: n, itemIndex: c }), o;
    }
    getValue(e, t) {
      let r = this._values[e];
      if (!r) return;
      return r.get(t);
    }
    scopeRefs(e, t = this._values) {
      return this._reduceValues(t, (r) => {
        if (r.scopePath === void 0) throw Error(`CodeGen: name "${r}" has no value`);
        return Tt._`${e}${r.scopePath}`;
      });
    }
    scopeCode(e = this._values, t, r) {
      return this._reduceValues(e, (o) => {
        if (o.value === void 0) throw Error(`CodeGen: name "${o}" has no value`);
        return o.value.code;
      }, t, r);
    }
    _reduceValues(e, t, r = {}, o) {
      let n = Tt.nil;
      for (let i in e) {
        let s = e[i];
        if (!s) continue;
        let a = r[i] = r[i] || /* @__PURE__ */ new Map();
        s.forEach((c) => {
          if (a.has(c)) return;
          a.set(c, Tm.Started);
          let u = t(c);
          if (u) {
            let d = this.opts.es5 ? aO.varKinds.var : aO.varKinds.const;
            n = Tt._`${n}${d} ${c} = ${u};${this.opts._n}`;
          } else if (u = o === null || o === void 0 ? void 0 : o(c)) n = Tt._`${n}${u}${this.opts._n}`;
          else throw new iO(c);
          a.set(c, Tm.Completed);
        });
      }
      return n;
    }
  }
  aO.ValueScope = sO;
});
var re = k((It) => {
  Object.defineProperty(It, "__esModule", { value: true });
  It.or = It.and = It.not = It.CodeGen = It.operators = It.varKinds = It.ValueScopeName = It.ValueScope = It.Scope = It.Name = It.regexpCode = It.stringify = It.getProperty = It.nil = It.strConcat = It.str = It._ = void 0;
  var le = jl(), hr = IS(), Ln = jl();
  Object.defineProperty(It, "_", { enumerable: true, get: function() {
    return Ln._;
  } });
  Object.defineProperty(It, "str", { enumerable: true, get: function() {
    return Ln.str;
  } });
  Object.defineProperty(It, "strConcat", { enumerable: true, get: function() {
    return Ln.strConcat;
  } });
  Object.defineProperty(It, "nil", { enumerable: true, get: function() {
    return Ln.nil;
  } });
  Object.defineProperty(It, "getProperty", { enumerable: true, get: function() {
    return Ln.getProperty;
  } });
  Object.defineProperty(It, "stringify", { enumerable: true, get: function() {
    return Ln.stringify;
  } });
  Object.defineProperty(It, "regexpCode", { enumerable: true, get: function() {
    return Ln.regexpCode;
  } });
  Object.defineProperty(It, "Name", { enumerable: true, get: function() {
    return Ln.Name;
  } });
  var Cm = IS();
  Object.defineProperty(It, "Scope", { enumerable: true, get: function() {
    return Cm.Scope;
  } });
  Object.defineProperty(It, "ValueScope", { enumerable: true, get: function() {
    return Cm.ValueScope;
  } });
  Object.defineProperty(It, "ValueScopeName", { enumerable: true, get: function() {
    return Cm.ValueScopeName;
  } });
  Object.defineProperty(It, "varKinds", { enumerable: true, get: function() {
    return Cm.varKinds;
  } });
  It.operators = { GT: new le._Code(">"), GTE: new le._Code(">="), LT: new le._Code("<"), LTE: new le._Code("<="), EQ: new le._Code("==="), NEQ: new le._Code("!=="), NOT: new le._Code("!"), OR: new le._Code("||"), AND: new le._Code("&&"), ADD: new le._Code("+") };
  class Fn {
    optimizeNodes() {
      return this;
    }
    optimizeNames(e, t) {
      return this;
    }
  }
  class lO extends Fn {
    constructor(e, t, r) {
      super();
      this.varKind = e, this.name = t, this.rhs = r;
    }
    render({ es5: e, _n: t }) {
      let r = e ? hr.varKinds.var : this.varKind, o = this.rhs === void 0 ? "" : ` = ${this.rhs}`;
      return `${r} ${this.name}${o};` + t;
    }
    optimizeNames(e, t) {
      if (!e[this.name.str]) return;
      if (this.rhs) this.rhs = Ss(this.rhs, e, t);
      return this;
    }
    get names() {
      return this.rhs instanceof le._CodeOrName ? this.rhs.names : {};
    }
  }
  class AS extends Fn {
    constructor(e, t, r) {
      super();
      this.lhs = e, this.rhs = t, this.sideEffects = r;
    }
    render({ _n: e }) {
      return `${this.lhs} = ${this.rhs};` + e;
    }
    optimizeNames(e, t) {
      if (this.lhs instanceof le.Name && !e[this.lhs.str] && !this.sideEffects) return;
      return this.rhs = Ss(this.rhs, e, t), this;
    }
    get names() {
      let e = this.lhs instanceof le.Name ? {} : { ...this.lhs.names };
      return Om(e, this.rhs);
    }
  }
  class uO extends AS {
    constructor(e, t, r, o) {
      super(e, r, o);
      this.op = t;
    }
    render({ _n: e }) {
      return `${this.lhs} ${this.op}= ${this.rhs};` + e;
    }
  }
  class dO extends Fn {
    constructor(e) {
      super();
      this.label = e, this.names = {};
    }
    render({ _n: e }) {
      return `${this.label}:` + e;
    }
  }
  class pO extends Fn {
    constructor(e) {
      super();
      this.label = e, this.names = {};
    }
    render({ _n: e }) {
      return `break${this.label ? ` ${this.label}` : ""};` + e;
    }
  }
  class fO extends Fn {
    constructor(e) {
      super();
      this.error = e;
    }
    render({ _n: e }) {
      return `throw ${this.error};` + e;
    }
    get names() {
      return this.error.names;
    }
  }
  class mO extends Fn {
    constructor(e) {
      super();
      this.code = e;
    }
    render({ _n: e }) {
      return `${this.code};` + e;
    }
    optimizeNodes() {
      return `${this.code}` ? this : void 0;
    }
    optimizeNames(e, t) {
      return this.code = Ss(this.code, e, t), this;
    }
    get names() {
      return this.code instanceof le._CodeOrName ? this.code.names : {};
    }
  }
  class Mm extends Fn {
    constructor(e = []) {
      super();
      this.nodes = e;
    }
    render(e) {
      return this.nodes.reduce((t, r) => t + r.render(e), "");
    }
    optimizeNodes() {
      let { nodes: e } = this, t = e.length;
      while (t--) {
        let r = e[t].optimizeNodes();
        if (Array.isArray(r)) e.splice(t, 1, ...r);
        else if (r) e[t] = r;
        else e.splice(t, 1);
      }
      return e.length > 0 ? this : void 0;
    }
    optimizeNames(e, t) {
      let { nodes: r } = this, o = r.length;
      while (o--) {
        let n = r[o];
        if (n.optimizeNames(e, t)) continue;
        uJ(e, n.names), r.splice(o, 1);
      }
      return r.length > 0 ? this : void 0;
    }
    get names() {
      return this.nodes.reduce((e, t) => jo(e, t.names), {});
    }
  }
  class Hn extends Mm {
    render(e) {
      return "{" + e._n + super.render(e) + "}" + e._n;
    }
  }
  class gO extends Mm {
  }
  class Ul extends Hn {
  }
  Ul.kind = "else";
  class rn extends Hn {
    constructor(e, t) {
      super(t);
      this.condition = e;
    }
    render(e) {
      let t = `if(${this.condition})` + super.render(e);
      if (this.else) t += "else " + this.else.render(e);
      return t;
    }
    optimizeNodes() {
      super.optimizeNodes();
      let e = this.condition;
      if (e === true) return this.nodes;
      let t = this.else;
      if (t) {
        let r = t.optimizeNodes();
        t = this.else = Array.isArray(r) ? new Ul(r) : r;
      }
      if (t) {
        if (e === false) return t instanceof rn ? t : t.nodes;
        if (this.nodes.length) return this;
        return new rn(vO(e), t instanceof rn ? [t] : t.nodes);
      }
      if (e === false || !this.nodes.length) return;
      return this;
    }
    optimizeNames(e, t) {
      var r;
      if (this.else = (r = this.else) === null || r === void 0 ? void 0 : r.optimizeNames(e, t), !(super.optimizeNames(e, t) || this.else)) return;
      return this.condition = Ss(this.condition, e, t), this;
    }
    get names() {
      let e = super.names;
      if (Om(e, this.condition), this.else) jo(e, this.else.names);
      return e;
    }
  }
  rn.kind = "if";
  class vs extends Hn {
  }
  vs.kind = "for";
  class hO extends vs {
    constructor(e) {
      super();
      this.iteration = e;
    }
    render(e) {
      return `for(${this.iteration})` + super.render(e);
    }
    optimizeNames(e, t) {
      if (!super.optimizeNames(e, t)) return;
      return this.iteration = Ss(this.iteration, e, t), this;
    }
    get names() {
      return jo(super.names, this.iteration.names);
    }
  }
  class yO extends vs {
    constructor(e, t, r, o) {
      super();
      this.varKind = e, this.name = t, this.from = r, this.to = o;
    }
    render(e) {
      let t = e.es5 ? hr.varKinds.var : this.varKind, { name: r, from: o, to: n } = this;
      return `for(${t} ${r}=${o}; ${r}<${n}; ${r}++)` + super.render(e);
    }
    get names() {
      let e = Om(super.names, this.from);
      return Om(e, this.to);
    }
  }
  class RS extends vs {
    constructor(e, t, r, o) {
      super();
      this.loop = e, this.varKind = t, this.name = r, this.iterable = o;
    }
    render(e) {
      return `for(${this.varKind} ${this.name} ${this.loop} ${this.iterable})` + super.render(e);
    }
    optimizeNames(e, t) {
      if (!super.optimizeNames(e, t)) return;
      return this.iterable = Ss(this.iterable, e, t), this;
    }
    get names() {
      return jo(super.names, this.iterable.names);
    }
  }
  class Im extends Hn {
    constructor(e, t, r) {
      super();
      this.name = e, this.args = t, this.async = r;
    }
    render(e) {
      return `${this.async ? "async " : ""}function ${this.name}(${this.args})` + super.render(e);
    }
  }
  Im.kind = "func";
  class Rm extends Mm {
    render(e) {
      return "return " + super.render(e);
    }
  }
  Rm.kind = "return";
  class bO extends Hn {
    render(e) {
      let t = "try" + super.render(e);
      if (this.catch) t += this.catch.render(e);
      if (this.finally) t += this.finally.render(e);
      return t;
    }
    optimizeNodes() {
      var e, t;
      return super.optimizeNodes(), (e = this.catch) === null || e === void 0 || e.optimizeNodes(), (t = this.finally) === null || t === void 0 || t.optimizeNodes(), this;
    }
    optimizeNames(e, t) {
      var r, o;
      return super.optimizeNames(e, t), (r = this.catch) === null || r === void 0 || r.optimizeNames(e, t), (o = this.finally) === null || o === void 0 || o.optimizeNames(e, t), this;
    }
    get names() {
      let e = super.names;
      if (this.catch) jo(e, this.catch.names);
      if (this.finally) jo(e, this.finally.names);
      return e;
    }
  }
  class $m extends Hn {
    constructor(e) {
      super();
      this.error = e;
    }
    render(e) {
      return `catch(${this.error})` + super.render(e);
    }
  }
  $m.kind = "catch";
  class Am extends Hn {
    render(e) {
      return "finally" + super.render(e);
    }
  }
  Am.kind = "finally";
  class _O {
    constructor(e, t = {}) {
      this._values = {}, this._blockStarts = [], this._constants = {}, this.opts = { ...t, _n: t.lines ? `
` : "" }, this._extScope = e, this._scope = new hr.Scope({ parent: e }), this._nodes = [new gO()];
    }
    toString() {
      return this._root.render(this.opts);
    }
    name(e) {
      return this._scope.name(e);
    }
    scopeName(e) {
      return this._extScope.name(e);
    }
    scopeValue(e, t) {
      let r = this._extScope.value(e, t);
      return (this._values[r.prefix] || (this._values[r.prefix] = /* @__PURE__ */ new Set())).add(r), r;
    }
    getScopeValue(e, t) {
      return this._extScope.getValue(e, t);
    }
    scopeRefs(e) {
      return this._extScope.scopeRefs(e, this._values);
    }
    scopeCode() {
      return this._extScope.scopeCode(this._values);
    }
    _def(e, t, r, o) {
      let n = this._scope.toName(t);
      if (r !== void 0 && o) this._constants[n.str] = r;
      return this._leafNode(new lO(e, n, r)), n;
    }
    const(e, t, r) {
      return this._def(hr.varKinds.const, e, t, r);
    }
    let(e, t, r) {
      return this._def(hr.varKinds.let, e, t, r);
    }
    var(e, t, r) {
      return this._def(hr.varKinds.var, e, t, r);
    }
    assign(e, t, r) {
      return this._leafNode(new AS(e, t, r));
    }
    add(e, t) {
      return this._leafNode(new uO(e, It.operators.ADD, t));
    }
    code(e) {
      if (typeof e == "function") e();
      else if (e !== le.nil) this._leafNode(new mO(e));
      return this;
    }
    object(...e) {
      let t = ["{"];
      for (let [r, o] of e) {
        if (t.length > 1) t.push(",");
        if (t.push(r), r !== o || this.opts.es5) t.push(":"), (0, le.addCodeArg)(t, o);
      }
      return t.push("}"), new le._Code(t);
    }
    if(e, t, r) {
      if (this._blockNode(new rn(e)), t && r) this.code(t).else().code(r).endIf();
      else if (t) this.code(t).endIf();
      else if (r) throw Error('CodeGen: "else" body without "then" body');
      return this;
    }
    elseIf(e) {
      return this._elseNode(new rn(e));
    }
    else() {
      return this._elseNode(new Ul());
    }
    endIf() {
      return this._endBlockNode(rn, Ul);
    }
    _for(e, t) {
      if (this._blockNode(e), t) this.code(t).endFor();
      return this;
    }
    for(e, t) {
      return this._for(new hO(e), t);
    }
    forRange(e, t, r, o, n = this.opts.es5 ? hr.varKinds.var : hr.varKinds.let) {
      let i = this._scope.toName(e);
      return this._for(new yO(n, i, t, r), () => o(i));
    }
    forOf(e, t, r, o = hr.varKinds.const) {
      let n = this._scope.toName(e);
      if (this.opts.es5) {
        let i = t instanceof le.Name ? t : this.var("_arr", t);
        return this.forRange("_i", 0, le._`${i}.length`, (s) => {
          this.var(n, le._`${i}[${s}]`), r(n);
        });
      }
      return this._for(new RS("of", o, n, t), () => r(n));
    }
    forIn(e, t, r, o = this.opts.es5 ? hr.varKinds.var : hr.varKinds.const) {
      if (this.opts.ownProperties) return this.forOf(e, le._`Object.keys(${t})`, r);
      let n = this._scope.toName(e);
      return this._for(new RS("in", o, n, t), () => r(n));
    }
    endFor() {
      return this._endBlockNode(vs);
    }
    label(e) {
      return this._leafNode(new dO(e));
    }
    break(e) {
      return this._leafNode(new pO(e));
    }
    return(e) {
      let t = new Rm();
      if (this._blockNode(t), this.code(e), t.nodes.length !== 1) throw Error('CodeGen: "return" should have one node');
      return this._endBlockNode(Rm);
    }
    try(e, t, r) {
      if (!t && !r) throw Error('CodeGen: "try" without "catch" and "finally"');
      let o = new bO();
      if (this._blockNode(o), this.code(e), t) {
        let n = this.name("e");
        this._currNode = o.catch = new $m(n), t(n);
      }
      if (r) this._currNode = o.finally = new Am(), this.code(r);
      return this._endBlockNode($m, Am);
    }
    throw(e) {
      return this._leafNode(new fO(e));
    }
    block(e, t) {
      if (this._blockStarts.push(this._nodes.length), e) this.code(e).endBlock(t);
      return this;
    }
    endBlock(e) {
      let t = this._blockStarts.pop();
      if (t === void 0) throw Error("CodeGen: not in self-balancing block");
      let r = this._nodes.length - t;
      if (r < 0 || e !== void 0 && r !== e) throw Error(`CodeGen: wrong number of nodes: ${r} vs ${e} expected`);
      return this._nodes.length = t, this;
    }
    func(e, t = le.nil, r, o) {
      if (this._blockNode(new Im(e, t, r)), o) this.code(o).endFunc();
      return this;
    }
    endFunc() {
      return this._endBlockNode(Im);
    }
    optimize(e = 1) {
      while (e-- > 0) this._root.optimizeNodes(), this._root.optimizeNames(this._root.names, this._constants);
    }
    _leafNode(e) {
      return this._currNode.nodes.push(e), this;
    }
    _blockNode(e) {
      this._currNode.nodes.push(e), this._nodes.push(e);
    }
    _endBlockNode(e, t) {
      let r = this._currNode;
      if (r instanceof e || t && r instanceof t) return this._nodes.pop(), this;
      throw Error(`CodeGen: not in block "${t ? `${e.kind}/${t.kind}` : e.kind}"`);
    }
    _elseNode(e) {
      let t = this._currNode;
      if (!(t instanceof rn)) throw Error('CodeGen: "else" without "if"');
      return this._currNode = t.else = e, this;
    }
    get _root() {
      return this._nodes[0];
    }
    get _currNode() {
      let e = this._nodes;
      return e[e.length - 1];
    }
    set _currNode(e) {
      let t = this._nodes;
      t[t.length - 1] = e;
    }
  }
  It.CodeGen = _O;
  function jo(e, t) {
    for (let r in t) e[r] = (e[r] || 0) + (t[r] || 0);
    return e;
  }
  function Om(e, t) {
    return t instanceof le._CodeOrName ? jo(e, t.names) : e;
  }
  function Ss(e, t, r) {
    if (e instanceof le.Name) return o(e);
    if (!n(e)) return e;
    return new le._Code(e._items.reduce((i, s) => {
      if (s instanceof le.Name) s = o(s);
      if (s instanceof le._Code) i.push(...s._items);
      else i.push(s);
      return i;
    }, []));
    function o(i) {
      let s = r[i.str];
      if (s === void 0 || t[i.str] !== 1) return i;
      return delete t[i.str], s;
    }
    function n(i) {
      return i instanceof le._Code && i._items.some((s) => s instanceof le.Name && t[s.str] === 1 && r[s.str] !== void 0);
    }
  }
  function uJ(e, t) {
    for (let r in t) e[r] = (e[r] || 0) - (t[r] || 0);
  }
  function vO(e) {
    return typeof e == "boolean" || typeof e == "number" || e === null ? !e : le._`!${$S(e)}`;
  }
  It.not = vO;
  var dJ = SO(It.operators.AND);
  function pJ(...e) {
    return e.reduce(dJ);
  }
  It.and = pJ;
  var fJ = SO(It.operators.OR);
  function mJ(...e) {
    return e.reduce(fJ);
  }
  It.or = mJ;
  function SO(e) {
    return (t, r) => t === le.nil ? r : r === le.nil ? t : le._`${$S(t)} ${e} ${$S(r)}`;
  }
  function $S(e) {
    return e instanceof le.Name ? e : le._`(${e})`;
  }
});
var ue = k(($O) => {
  Object.defineProperty($O, "__esModule", { value: true });
  $O.checkStrictMode = $O.getErrorPath = $O.Type = $O.useFunc = $O.setEvaluated = $O.evaluatedPropsToName = $O.mergeEvaluated = $O.eachItem = $O.unescapeJsonPointer = $O.escapeJsonPointer = $O.escapeFragment = $O.unescapeFragment = $O.schemaRefOrVal = $O.schemaHasRulesButRef = $O.schemaHasRules = $O.checkUnknownRules = $O.alwaysValidSchema = $O.toHash = void 0;
  var Pe = re(), bJ = jl();
  function _J(e) {
    let t = {};
    for (let r of e) t[r] = true;
    return t;
  }
  $O.toHash = _J;
  function vJ(e, t) {
    if (typeof t == "boolean") return t;
    if (Object.keys(t).length === 0) return true;
    return EO(e, t), !PO(t, e.self.RULES.all);
  }
  $O.alwaysValidSchema = vJ;
  function EO(e, t = e.schema) {
    let { opts: r, self: o } = e;
    if (!r.strictSchema) return;
    if (typeof t === "boolean") return;
    let n = o.RULES.keywords;
    for (let i in t) if (!n[i]) RO(e, `unknown keyword: "${i}"`);
  }
  $O.checkUnknownRules = EO;
  function PO(e, t) {
    if (typeof e == "boolean") return !e;
    for (let r in e) if (t[r]) return true;
    return false;
  }
  $O.schemaHasRules = PO;
  function SJ(e, t) {
    if (typeof e == "boolean") return !e;
    for (let r in e) if (r !== "$ref" && t.all[r]) return true;
    return false;
  }
  $O.schemaHasRulesButRef = SJ;
  function xJ({ topSchemaRef: e, schemaPath: t }, r, o, n) {
    if (!n) {
      if (typeof r == "number" || typeof r == "boolean") return r;
      if (typeof r == "string") return Pe._`${r}`;
    }
    return Pe._`${e}${t}${(0, Pe.getProperty)(o)}`;
  }
  $O.schemaRefOrVal = xJ;
  function wJ(e) {
    return TO(decodeURIComponent(e));
  }
  $O.unescapeFragment = wJ;
  function kJ(e) {
    return encodeURIComponent(CS(e));
  }
  $O.escapeFragment = kJ;
  function CS(e) {
    if (typeof e == "number") return `${e}`;
    return e.replace(/~/g, "~0").replace(/\//g, "~1");
  }
  $O.escapeJsonPointer = CS;
  function TO(e) {
    return e.replace(/~1/g, "/").replace(/~0/g, "~");
  }
  $O.unescapeJsonPointer = TO;
  function EJ(e, t) {
    if (Array.isArray(e)) for (let r of e) t(r);
    else t(e);
  }
  $O.eachItem = EJ;
  function wO({ mergeNames: e, mergeToName: t, mergeValues: r, resultToName: o }) {
    return (n, i, s, a) => {
      let c = s === void 0 ? i : s instanceof Pe.Name ? (i instanceof Pe.Name ? e(n, i, s) : t(n, i, s), s) : i instanceof Pe.Name ? (t(n, s, i), i) : r(i, s);
      return a === Pe.Name && !(c instanceof Pe.Name) ? o(n, c) : c;
    };
  }
  $O.mergeEvaluated = { props: wO({ mergeNames: (e, t, r) => e.if(Pe._`${r} !== true && ${t} !== undefined`, () => {
    e.if(Pe._`${t} === true`, () => e.assign(r, true), () => e.assign(r, Pe._`${r} || {}`).code(Pe._`Object.assign(${r}, ${t})`));
  }), mergeToName: (e, t, r) => e.if(Pe._`${r} !== true`, () => {
    if (t === true) e.assign(r, true);
    else e.assign(r, Pe._`${r} || {}`), MS(e, r, t);
  }), mergeValues: (e, t) => e === true ? true : { ...e, ...t }, resultToName: IO }), items: wO({ mergeNames: (e, t, r) => e.if(Pe._`${r} !== true && ${t} !== undefined`, () => e.assign(r, Pe._`${t} === true ? true : ${r} > ${t} ? ${r} : ${t}`)), mergeToName: (e, t, r) => e.if(Pe._`${r} !== true`, () => e.assign(r, t === true ? true : Pe._`${r} > ${t} ? ${r} : ${t}`)), mergeValues: (e, t) => e === true ? true : Math.max(e, t), resultToName: (e, t) => e.var("items", t) }) };
  function IO(e, t) {
    if (t === true) return e.var("props", true);
    let r = e.var("props", Pe._`{}`);
    if (t !== void 0) MS(e, r, t);
    return r;
  }
  $O.evaluatedPropsToName = IO;
  function MS(e, t, r) {
    Object.keys(r).forEach((o) => e.assign(Pe._`${t}${(0, Pe.getProperty)(o)}`, true));
  }
  $O.setEvaluated = MS;
  var kO = {};
  function PJ(e, t) {
    return e.scopeValue("func", { ref: t, code: kO[t.code] || (kO[t.code] = new bJ._Code(t.code)) });
  }
  $O.useFunc = PJ;
  var OS;
  (function(e) {
    e[e.Num = 0] = "Num", e[e.Str = 1] = "Str";
  })(OS || ($O.Type = OS = {}));
  function TJ(e, t, r) {
    if (e instanceof Pe.Name) {
      let o = t === OS.Num;
      return r ? o ? Pe._`"[" + ${e} + "]"` : Pe._`"['" + ${e} + "']"` : o ? Pe._`"/" + ${e}` : Pe._`"/" + ${e}.replace(/~/g, "~0").replace(/\\//g, "~1")`;
    }
    return r ? (0, Pe.getProperty)(e).toString() : "/" + CS(e);
  }
  $O.getErrorPath = TJ;
  function RO(e, t, r = e.opts.strictSchema) {
    if (!r) return;
    if (t = `strict mode: ${t}`, r === true) throw Error(t);
    e.self.logger.warn(t);
  }
  $O.checkStrictMode = RO;
});
var nn = k((OO) => {
  Object.defineProperty(OO, "__esModule", { value: true });
  var ut = re(), VJ = { data: new ut.Name("data"), valCxt: new ut.Name("valCxt"), instancePath: new ut.Name("instancePath"), parentData: new ut.Name("parentData"), parentDataProperty: new ut.Name("parentDataProperty"), rootData: new ut.Name("rootData"), dynamicAnchors: new ut.Name("dynamicAnchors"), vErrors: new ut.Name("vErrors"), errors: new ut.Name("errors"), this: new ut.Name("this"), self: new ut.Name("self"), scope: new ut.Name("scope"), json: new ut.Name("json"), jsonPos: new ut.Name("jsonPos"), jsonLen: new ut.Name("jsonLen"), jsonPart: new ut.Name("jsonPart") };
  OO.default = VJ;
});
var zl = k((NO) => {
  Object.defineProperty(NO, "__esModule", { value: true });
  NO.extendErrors = NO.resetErrorsCount = NO.reportExtraError = NO.reportError = NO.keyword$DataError = NO.keywordError = void 0;
  var de = re(), Nm = ue(), yt = nn();
  NO.keywordError = { message: ({ keyword: e }) => de.str`must pass "${e}" keyword validation` };
  NO.keyword$DataError = { message: ({ keyword: e, schemaType: t }) => t ? de.str`"${e}" keyword must be ${t} ($data)` : de.str`"${e}" keyword is invalid ($data)` };
  function WJ(e, t = NO.keywordError, r, o) {
    let { it: n } = e, { gen: i, compositeRule: s, allErrors: a } = n, c = DO(e, t, r);
    if (o !== null && o !== void 0 ? o : s || a) CO(i, c);
    else MO(n, de._`[${c}]`);
  }
  NO.reportError = WJ;
  function KJ(e, t = NO.keywordError, r) {
    let { it: o } = e, { gen: n, compositeRule: i, allErrors: s } = o, a = DO(e, t, r);
    if (CO(n, a), !(i || s)) MO(o, yt.default.vErrors);
  }
  NO.reportExtraError = KJ;
  function GJ(e, t) {
    e.assign(yt.default.errors, t), e.if(de._`${yt.default.vErrors} !== null`, () => e.if(t, () => e.assign(de._`${yt.default.vErrors}.length`, t), () => e.assign(yt.default.vErrors, null)));
  }
  NO.resetErrorsCount = GJ;
  function JJ({ gen: e, keyword: t, schemaValue: r, data: o, errsCount: n, it: i }) {
    if (n === void 0) throw Error("ajv implementation error");
    let s = e.name("err");
    e.forRange("i", n, yt.default.errors, (a) => {
      if (e.const(s, de._`${yt.default.vErrors}[${a}]`), e.if(de._`${s}.instancePath === undefined`, () => e.assign(de._`${s}.instancePath`, (0, de.strConcat)(yt.default.instancePath, i.errorPath))), e.assign(de._`${s}.schemaPath`, de.str`${i.errSchemaPath}/${t}`), i.opts.verbose) e.assign(de._`${s}.schema`, r), e.assign(de._`${s}.data`, o);
    });
  }
  NO.extendErrors = JJ;
  function CO(e, t) {
    let r = e.const("err", t);
    e.if(de._`${yt.default.vErrors} === null`, () => e.assign(yt.default.vErrors, de._`[${r}]`), de._`${yt.default.vErrors}.push(${r})`), e.code(de._`${yt.default.errors}++`);
  }
  function MO(e, t) {
    let { gen: r, validateName: o, schemaEnv: n } = e;
    if (n.$async) r.throw(de._`new ${e.ValidationError}(${t})`);
    else r.assign(de._`${o}.errors`, t), r.return(false);
  }
  var Uo = { keyword: new de.Name("keyword"), schemaPath: new de.Name("schemaPath"), params: new de.Name("params"), propertyName: new de.Name("propertyName"), message: new de.Name("message"), schema: new de.Name("schema"), parentSchema: new de.Name("parentSchema") };
  function DO(e, t, r) {
    let { createErrors: o } = e.it;
    if (o === false) return de._`{}`;
    return XJ(e, t, r);
  }
  function XJ(e, t, r = {}) {
    let { gen: o, it: n } = e, i = [YJ(n, r), QJ(e, r)];
    return e5(e, t, i), o.object(...i);
  }
  function YJ({ errorPath: e }, { instancePath: t }) {
    let r = t ? de.str`${e}${(0, Nm.getErrorPath)(t, Nm.Type.Str)}` : e;
    return [yt.default.instancePath, (0, de.strConcat)(yt.default.instancePath, r)];
  }
  function QJ({ keyword: e, it: { errSchemaPath: t } }, { schemaPath: r, parentSchema: o }) {
    let n = o ? t : de.str`${t}/${e}`;
    if (r) n = de.str`${n}${(0, Nm.getErrorPath)(r, Nm.Type.Str)}`;
    return [Uo.schemaPath, n];
  }
  function e5(e, { params: t, message: r }, o) {
    let { keyword: n, data: i, schemaValue: s, it: a } = e, { opts: c, propertyName: u, topSchemaRef: d, schemaPath: p } = a;
    if (o.push([Uo.keyword, n], [Uo.params, typeof t == "function" ? t(e) : t || de._`{}`]), c.messages) o.push([Uo.message, typeof r == "function" ? r(e) : r]);
    if (c.verbose) o.push([Uo.schema, s], [Uo.parentSchema, de._`${d}${p}`], [yt.default.data, i]);
    if (u) o.push([Uo.propertyName, u]);
  }
});
var FO = k((zO) => {
  Object.defineProperty(zO, "__esModule", { value: true });
  zO.boolOrEmptySchema = zO.topBoolOrEmptySchema = void 0;
  var i5 = zl(), s5 = re(), a5 = nn(), c5 = { message: "boolean schema is false" };
  function l5(e) {
    let { gen: t, schema: r, validateName: o } = e;
    if (r === false) UO(e, false);
    else if (typeof r == "object" && r.$async === true) t.return(a5.default.data);
    else t.assign(s5._`${o}.errors`, null), t.return(true);
  }
  zO.topBoolOrEmptySchema = l5;
  function u5(e, t) {
    let { gen: r, schema: o } = e;
    if (o === false) r.var(t, false), UO(e);
    else r.var(t, true);
  }
  zO.boolOrEmptySchema = u5;
  function UO(e, t) {
    let { gen: r, data: o } = e, n = { gen: r, keyword: "false schema", data: o, schema: false, schemaCode: false, schemaValue: false, params: {}, it: e };
    (0, i5.reportError)(n, c5, void 0, t);
  }
});
var NS = k((HO) => {
  Object.defineProperty(HO, "__esModule", { value: true });
  HO.getRules = HO.isJSONType = void 0;
  var p5 = ["string", "number", "integer", "boolean", "null", "object", "array"], f5 = new Set(p5);
  function m5(e) {
    return typeof e == "string" && f5.has(e);
  }
  HO.isJSONType = m5;
  function g5() {
    let e = { number: { type: "number", rules: [] }, string: { type: "string", rules: [] }, array: { type: "array", rules: [] }, object: { type: "object", rules: [] } };
    return { types: { ...e, integer: true, boolean: true, null: true }, rules: [{ rules: [] }, e.number, e.string, e.array, e.object], post: { rules: [] }, all: {}, keywords: {} };
  }
  HO.getRules = g5;
});
var jS = k((ZO) => {
  Object.defineProperty(ZO, "__esModule", { value: true });
  ZO.shouldUseRule = ZO.shouldUseGroup = ZO.schemaHasRulesForType = void 0;
  function y5({ schema: e, self: t }, r) {
    let o = t.RULES.types[r];
    return o && o !== true && qO(e, o);
  }
  ZO.schemaHasRulesForType = y5;
  function qO(e, t) {
    return t.rules.some((r) => VO(e, r));
  }
  ZO.shouldUseGroup = qO;
  function VO(e, t) {
    var r;
    return e[t.keyword] !== void 0 || ((r = t.definition.implements) === null || r === void 0 ? void 0 : r.some((o) => e[o] !== void 0));
  }
  ZO.shouldUseRule = VO;
});
var Ll = k((XO) => {
  Object.defineProperty(XO, "__esModule", { value: true });
  XO.reportTypeError = XO.checkDataTypes = XO.checkDataType = XO.coerceAndCheckDataType = XO.getJSONTypes = XO.getSchemaTypes = XO.DataType = void 0;
  var v5 = NS(), S5 = jS(), x5 = zl(), te = re(), KO = ue(), xs;
  (function(e) {
    e[e.Correct = 0] = "Correct", e[e.Wrong = 1] = "Wrong";
  })(xs || (XO.DataType = xs = {}));
  function w5(e) {
    let t = GO(e.type);
    if (t.includes("null")) {
      if (e.nullable === false) throw Error("type: null contradicts nullable: false");
    } else {
      if (!t.length && e.nullable !== void 0) throw Error('"nullable" cannot be used without "type"');
      if (e.nullable === true) t.push("null");
    }
    return t;
  }
  XO.getSchemaTypes = w5;
  function GO(e) {
    let t = Array.isArray(e) ? e : e ? [e] : [];
    if (t.every(v5.isJSONType)) return t;
    throw Error("type must be JSONType or JSONType[]: " + t.join(","));
  }
  XO.getJSONTypes = GO;
  function k5(e, t) {
    let { gen: r, data: o, opts: n } = e, i = E5(t, n.coerceTypes), s = t.length > 0 && !(i.length === 0 && t.length === 1 && (0, S5.schemaHasRulesForType)(e, t[0]));
    if (s) {
      let a = zS(t, o, n.strictNumbers, xs.Wrong);
      r.if(a, () => {
        if (i.length) P5(e, t, i);
        else LS(e);
      });
    }
    return s;
  }
  XO.coerceAndCheckDataType = k5;
  var JO = /* @__PURE__ */ new Set(["string", "number", "integer", "boolean", "null"]);
  function E5(e, t) {
    return t ? e.filter((r) => JO.has(r) || t === "array" && r === "array") : [];
  }
  function P5(e, t, r) {
    let { gen: o, data: n, opts: i } = e, s = o.let("dataType", te._`typeof ${n}`), a = o.let("coerced", te._`undefined`);
    if (i.coerceTypes === "array") o.if(te._`${s} == 'object' && Array.isArray(${n}) && ${n}.length == 1`, () => o.assign(n, te._`${n}[0]`).assign(s, te._`typeof ${n}`).if(zS(t, n, i.strictNumbers), () => o.assign(a, n)));
    o.if(te._`${a} !== undefined`);
    for (let u of r) if (JO.has(u) || u === "array" && i.coerceTypes === "array") c(u);
    o.else(), LS(e), o.endIf(), o.if(te._`${a} !== undefined`, () => {
      o.assign(n, a), T5(e, a);
    });
    function c(u) {
      switch (u) {
        case "string":
          o.elseIf(te._`${s} == "number" || ${s} == "boolean"`).assign(a, te._`"" + ${n}`).elseIf(te._`${n} === null`).assign(a, te._`""`);
          return;
        case "number":
          o.elseIf(te._`${s} == "boolean" || ${n} === null
              || (${s} == "string" && ${n} && ${n} == +${n})`).assign(a, te._`+${n}`);
          return;
        case "integer":
          o.elseIf(te._`${s} === "boolean" || ${n} === null
              || (${s} === "string" && ${n} && ${n} == +${n} && !(${n} % 1))`).assign(a, te._`+${n}`);
          return;
        case "boolean":
          o.elseIf(te._`${n} === "false" || ${n} === 0 || ${n} === null`).assign(a, false).elseIf(te._`${n} === "true" || ${n} === 1`).assign(a, true);
          return;
        case "null":
          o.elseIf(te._`${n} === "" || ${n} === 0 || ${n} === false`), o.assign(a, null);
          return;
        case "array":
          o.elseIf(te._`${s} === "string" || ${s} === "number"
              || ${s} === "boolean" || ${n} === null`).assign(a, te._`[${n}]`);
      }
    }
  }
  function T5({ gen: e, parentData: t, parentDataProperty: r }, o) {
    e.if(te._`${t} !== undefined`, () => e.assign(te._`${t}[${r}]`, o));
  }
  function US(e, t, r, o = xs.Correct) {
    let n = o === xs.Correct ? te.operators.EQ : te.operators.NEQ, i;
    switch (e) {
      case "null":
        return te._`${t} ${n} null`;
      case "array":
        i = te._`Array.isArray(${t})`;
        break;
      case "object":
        i = te._`${t} && typeof ${t} == "object" && !Array.isArray(${t})`;
        break;
      case "integer":
        i = s(te._`!(${t} % 1) && !isNaN(${t})`);
        break;
      case "number":
        i = s();
        break;
      default:
        return te._`typeof ${t} ${n} ${e}`;
    }
    return o === xs.Correct ? i : (0, te.not)(i);
    function s(a = te.nil) {
      return (0, te.and)(te._`typeof ${t} == "number"`, a, r ? te._`isFinite(${t})` : te.nil);
    }
  }
  XO.checkDataType = US;
  function zS(e, t, r, o) {
    if (e.length === 1) return US(e[0], t, r, o);
    let n, i = (0, KO.toHash)(e);
    if (i.array && i.object) {
      let s = te._`typeof ${t} != "object"`;
      n = i.null ? s : te._`!${t} || ${s}`, delete i.null, delete i.array, delete i.object;
    } else n = te.nil;
    if (i.number) delete i.integer;
    for (let s in i) n = (0, te.and)(n, US(s, t, r, o));
    return n;
  }
  XO.checkDataTypes = zS;
  var I5 = { message: ({ schema: e }) => `must be ${e}`, params: ({ schema: e, schemaValue: t }) => typeof e == "string" ? te._`{type: ${e}}` : te._`{type: ${t}}` };
  function LS(e) {
    let t = R5(e);
    (0, x5.reportError)(t, I5);
  }
  XO.reportTypeError = LS;
  function R5(e) {
    let { gen: t, data: r, schema: o } = e, n = (0, KO.schemaRefOrVal)(e, o, "type");
    return { gen: t, keyword: "type", data: r, schema: o.type, schemaCode: n, schemaValue: n, parentSchema: o, params: {}, it: e };
  }
});
var rC = k((eC) => {
  Object.defineProperty(eC, "__esModule", { value: true });
  eC.assignDefaults = void 0;
  var ws = re(), N5 = ue();
  function j5(e, t) {
    let { properties: r, items: o } = e.schema;
    if (t === "object" && r) for (let n in r) QO(e, n, r[n].default);
    else if (t === "array" && Array.isArray(o)) o.forEach((n, i) => QO(e, i, n.default));
  }
  eC.assignDefaults = j5;
  function QO(e, t, r) {
    let { gen: o, compositeRule: n, data: i, opts: s } = e;
    if (r === void 0) return;
    let a = ws._`${i}${(0, ws.getProperty)(t)}`;
    if (n) {
      (0, N5.checkStrictMode)(e, `default is ignored for: ${a}`);
      return;
    }
    let c = ws._`${a} === undefined`;
    if (s.useDefaults === "empty") c = ws._`${c} || ${a} === null || ${a} === ""`;
    o.if(c, ws._`${a} = ${(0, ws.stringify)(r)}`);
  }
});
var rr = k((iC) => {
  Object.defineProperty(iC, "__esModule", { value: true });
  iC.validateUnion = iC.validateArray = iC.usePattern = iC.callValidateCode = iC.schemaProperties = iC.allSchemaProperties = iC.noPropertyInData = iC.propertyInData = iC.isOwnProperty = iC.hasPropFunc = iC.reportMissingProp = iC.checkMissingProp = iC.checkReportMissingProp = void 0;
  var Oe = re(), FS = ue(), Bn = nn(), U5 = ue();
  function z5(e, t) {
    let { gen: r, data: o, it: n } = e;
    r.if(BS(r, o, t, n.opts.ownProperties), () => {
      e.setParams({ missingProperty: Oe._`${t}` }, true), e.error();
    });
  }
  iC.checkReportMissingProp = z5;
  function L5({ gen: e, data: t, it: { opts: r } }, o, n) {
    return (0, Oe.or)(...o.map((i) => (0, Oe.and)(BS(e, t, i, r.ownProperties), Oe._`${n} = ${i}`)));
  }
  iC.checkMissingProp = L5;
  function F5(e, t) {
    e.setParams({ missingProperty: t }, true), e.error();
  }
  iC.reportMissingProp = F5;
  function nC(e) {
    return e.scopeValue("func", { ref: Object.prototype.hasOwnProperty, code: Oe._`Object.prototype.hasOwnProperty` });
  }
  iC.hasPropFunc = nC;
  function HS(e, t, r) {
    return Oe._`${nC(e)}.call(${t}, ${r})`;
  }
  iC.isOwnProperty = HS;
  function H5(e, t, r, o) {
    let n = Oe._`${t}${(0, Oe.getProperty)(r)} !== undefined`;
    return o ? Oe._`${n} && ${HS(e, t, r)}` : n;
  }
  iC.propertyInData = H5;
  function BS(e, t, r, o) {
    let n = Oe._`${t}${(0, Oe.getProperty)(r)} === undefined`;
    return o ? (0, Oe.or)(n, (0, Oe.not)(HS(e, t, r))) : n;
  }
  iC.noPropertyInData = BS;
  function oC(e) {
    return e ? Object.keys(e).filter((t) => t !== "__proto__") : [];
  }
  iC.allSchemaProperties = oC;
  function B5(e, t) {
    return oC(t).filter((r) => !(0, FS.alwaysValidSchema)(e, t[r]));
  }
  iC.schemaProperties = B5;
  function q5({ schemaCode: e, data: t, it: { gen: r, topSchemaRef: o, schemaPath: n, errorPath: i }, it: s }, a, c, u) {
    let d = u ? Oe._`${e}, ${t}, ${o}${n}` : t, p = [[Bn.default.instancePath, (0, Oe.strConcat)(Bn.default.instancePath, i)], [Bn.default.parentData, s.parentData], [Bn.default.parentDataProperty, s.parentDataProperty], [Bn.default.rootData, Bn.default.rootData]];
    if (s.opts.dynamicRef) p.push([Bn.default.dynamicAnchors, Bn.default.dynamicAnchors]);
    let f = Oe._`${d}, ${r.object(...p)}`;
    return c !== Oe.nil ? Oe._`${a}.call(${c}, ${f})` : Oe._`${a}(${f})`;
  }
  iC.callValidateCode = q5;
  var V5 = Oe._`new RegExp`;
  function Z5({ gen: e, it: { opts: t } }, r) {
    let o = t.unicodeRegExp ? "u" : "", { regExp: n } = t.code, i = n(r, o);
    return e.scopeValue("pattern", { key: i.toString(), ref: i, code: Oe._`${n.code === "new RegExp" ? V5 : (0, U5.useFunc)(e, n)}(${r}, ${o})` });
  }
  iC.usePattern = Z5;
  function W5(e) {
    let { gen: t, data: r, keyword: o, it: n } = e, i = t.name("valid");
    if (n.allErrors) {
      let a = t.let("valid", true);
      return s(() => t.assign(a, false)), a;
    }
    return t.var(i, true), s(() => t.break()), i;
    function s(a) {
      let c = t.const("len", Oe._`${r}.length`);
      t.forRange("i", 0, c, (u) => {
        e.subschema({ keyword: o, dataProp: u, dataPropType: FS.Type.Num }, i), t.if((0, Oe.not)(i), a);
      });
    }
  }
  iC.validateArray = W5;
  function K5(e) {
    let { gen: t, schema: r, keyword: o, it: n } = e;
    if (!Array.isArray(r)) throw Error("ajv implementation error");
    if (r.some((c) => (0, FS.alwaysValidSchema)(n, c)) && !n.opts.unevaluated) return;
    let s = t.let("valid", false), a = t.name("_valid");
    t.block(() => r.forEach((c, u) => {
      let d = e.subschema({ keyword: o, schemaProp: u, compositeRule: true }, a);
      if (t.assign(s, Oe._`${s} || ${a}`), !e.mergeValidEvaluated(d, a)) t.if((0, Oe.not)(s));
    })), e.result(s, () => e.reset(), () => e.error(true));
  }
  iC.validateUnion = K5;
});
var dC = k((lC) => {
  Object.defineProperty(lC, "__esModule", { value: true });
  lC.validateKeywordUsage = lC.validSchemaType = lC.funcKeywordCode = lC.macroKeywordCode = void 0;
  var bt = re(), zo = nn(), a3 = rr(), c3 = zl();
  function l3(e, t) {
    let { gen: r, keyword: o, schema: n, parentSchema: i, it: s } = e, a = t.macro.call(s.self, n, i, s), c = cC(r, o, a);
    if (s.opts.validateSchema !== false) s.self.validateSchema(a, true);
    let u = r.name("valid");
    e.subschema({ schema: a, schemaPath: bt.nil, errSchemaPath: `${s.errSchemaPath}/${o}`, topSchemaRef: c, compositeRule: true }, u), e.pass(u, () => e.error(true));
  }
  lC.macroKeywordCode = l3;
  function u3(e, t) {
    var r;
    let { gen: o, keyword: n, schema: i, parentSchema: s, $data: a, it: c } = e;
    p3(c, t);
    let u = !a && t.compile ? t.compile.call(c.self, i, s, c) : t.validate, d = cC(o, n, u), p = o.let("valid");
    e.block$data(p, f), e.ok((r = t.valid) !== null && r !== void 0 ? r : p);
    function f() {
      if (t.errors === false) {
        if (h(), t.modifying) aC(e);
        y(() => e.error());
      } else {
        let v = t.async ? m() : g();
        if (t.modifying) aC(e);
        y(() => d3(e, v));
      }
    }
    function m() {
      let v = o.let("ruleErrs", null);
      return o.try(() => h(bt._`await `), (w) => o.assign(p, false).if(bt._`${w} instanceof ${c.ValidationError}`, () => o.assign(v, bt._`${w}.errors`), () => o.throw(w))), v;
    }
    function g() {
      let v = bt._`${d}.errors`;
      return o.assign(v, null), h(bt.nil), v;
    }
    function h(v = t.async ? bt._`await ` : bt.nil) {
      let w = c.opts.passContext ? zo.default.this : zo.default.self, x = !("compile" in t && !a || t.schema === false);
      o.assign(p, bt._`${v}${(0, a3.callValidateCode)(e, d, w, x)}`, t.modifying);
    }
    function y(v) {
      var w;
      o.if((0, bt.not)((w = t.valid) !== null && w !== void 0 ? w : p), v);
    }
  }
  lC.funcKeywordCode = u3;
  function aC(e) {
    let { gen: t, data: r, it: o } = e;
    t.if(o.parentData, () => t.assign(r, bt._`${o.parentData}[${o.parentDataProperty}]`));
  }
  function d3(e, t) {
    let { gen: r } = e;
    r.if(bt._`Array.isArray(${t})`, () => {
      r.assign(zo.default.vErrors, bt._`${zo.default.vErrors} === null ? ${t} : ${zo.default.vErrors}.concat(${t})`).assign(zo.default.errors, bt._`${zo.default.vErrors}.length`), (0, c3.extendErrors)(e);
    }, () => e.error());
  }
  function p3({ schemaEnv: e }, t) {
    if (t.async && !e.$async) throw Error("async keyword in sync schema");
  }
  function cC(e, t, r) {
    if (r === void 0) throw Error(`keyword "${t}" failed to compile`);
    return e.scopeValue("keyword", typeof r == "function" ? { ref: r } : { ref: r, code: (0, bt.stringify)(r) });
  }
  function f3(e, t, r = false) {
    return !t.length || t.some((o) => o === "array" ? Array.isArray(e) : o === "object" ? e && typeof e == "object" && !Array.isArray(e) : typeof e == o || r && typeof e > "u");
  }
  lC.validSchemaType = f3;
  function m3({ schema: e, opts: t, self: r, errSchemaPath: o }, n, i) {
    if (Array.isArray(n.keyword) ? !n.keyword.includes(i) : n.keyword !== i) throw Error("ajv implementation error");
    let s = n.dependencies;
    if (s === null || s === void 0 ? void 0 : s.some((a) => !Object.prototype.hasOwnProperty.call(e, a))) throw Error(`parent schema must have dependencies of ${i}: ${s.join(",")}`);
    if (n.validateSchema) {
      if (!n.validateSchema(e[i])) {
        let c = `keyword "${i}" value is invalid at path "${o}": ` + r.errorsText(n.validateSchema.errors);
        if (t.validateSchema === "log") r.logger.error(c);
        else throw Error(c);
      }
    }
  }
  lC.validateKeywordUsage = m3;
});
var gC = k((fC) => {
  Object.defineProperty(fC, "__esModule", { value: true });
  fC.extendSubschemaMode = fC.extendSubschemaData = fC.getSubschema = void 0;
  var Rr = re(), pC = ue();
  function b3(e, { keyword: t, schemaProp: r, schema: o, schemaPath: n, errSchemaPath: i, topSchemaRef: s }) {
    if (t !== void 0 && o !== void 0) throw Error('both "keyword" and "schema" passed, only one allowed');
    if (t !== void 0) {
      let a = e.schema[t];
      return r === void 0 ? { schema: a, schemaPath: Rr._`${e.schemaPath}${(0, Rr.getProperty)(t)}`, errSchemaPath: `${e.errSchemaPath}/${t}` } : { schema: a[r], schemaPath: Rr._`${e.schemaPath}${(0, Rr.getProperty)(t)}${(0, Rr.getProperty)(r)}`, errSchemaPath: `${e.errSchemaPath}/${t}/${(0, pC.escapeFragment)(r)}` };
    }
    if (o !== void 0) {
      if (n === void 0 || i === void 0 || s === void 0) throw Error('"schemaPath", "errSchemaPath" and "topSchemaRef" are required with "schema"');
      return { schema: o, schemaPath: n, topSchemaRef: s, errSchemaPath: i };
    }
    throw Error('either "keyword" or "schema" must be passed');
  }
  fC.getSubschema = b3;
  function _3(e, t, { dataProp: r, dataPropType: o, data: n, dataTypes: i, propertyName: s }) {
    if (n !== void 0 && r !== void 0) throw Error('both "data" and "dataProp" passed, only one allowed');
    let { gen: a } = t;
    if (r !== void 0) {
      let { errorPath: u, dataPathArr: d, opts: p } = t, f = a.let("data", Rr._`${t.data}${(0, Rr.getProperty)(r)}`, true);
      c(f), e.errorPath = Rr.str`${u}${(0, pC.getErrorPath)(r, o, p.jsPropertySyntax)}`, e.parentDataProperty = Rr._`${r}`, e.dataPathArr = [...d, e.parentDataProperty];
    }
    if (n !== void 0) {
      let u = n instanceof Rr.Name ? n : a.let("data", n, true);
      if (c(u), s !== void 0) e.propertyName = s;
    }
    if (i) e.dataTypes = i;
    function c(u) {
      e.data = u, e.dataLevel = t.dataLevel + 1, e.dataTypes = [], t.definedProperties = /* @__PURE__ */ new Set(), e.parentData = t.data, e.dataNames = [...t.dataNames, u];
    }
  }
  fC.extendSubschemaData = _3;
  function v3(e, { jtdDiscriminator: t, jtdMetadata: r, compositeRule: o, createErrors: n, allErrors: i }) {
    if (o !== void 0) e.compositeRule = o;
    if (n !== void 0) e.createErrors = n;
    if (i !== void 0) e.allErrors = i;
    e.jtdDiscriminator = t, e.jtdMetadata = r;
  }
  fC.extendSubschemaMode = v3;
});
var qS = k((DPe, hC) => {
  hC.exports = function e(t, r) {
    if (t === r) return true;
    if (t && r && typeof t == "object" && typeof r == "object") {
      if (t.constructor !== r.constructor) return false;
      var o, n, i;
      if (Array.isArray(t)) {
        if (o = t.length, o != r.length) return false;
        for (n = o; n-- !== 0; ) if (!e(t[n], r[n])) return false;
        return true;
      }
      if (t.constructor === RegExp) return t.source === r.source && t.flags === r.flags;
      if (t.valueOf !== Object.prototype.valueOf) return t.valueOf() === r.valueOf();
      if (t.toString !== Object.prototype.toString) return t.toString() === r.toString();
      if (i = Object.keys(t), o = i.length, o !== Object.keys(r).length) return false;
      for (n = o; n-- !== 0; ) if (!Object.prototype.hasOwnProperty.call(r, i[n])) return false;
      for (n = o; n-- !== 0; ) {
        var s = i[n];
        if (!e(t[s], r[s])) return false;
      }
      return true;
    }
    return t !== t && r !== r;
  };
});
var bC = k((NPe, yC) => {
  var qn = yC.exports = function(e, t, r) {
    if (typeof t == "function") r = t, t = {};
    r = t.cb || r;
    var o = typeof r == "function" ? r : r.pre || function() {
    }, n = r.post || function() {
    };
    jm(t, o, n, e, "", e);
  };
  qn.keywords = { additionalItems: true, items: true, contains: true, additionalProperties: true, propertyNames: true, not: true, if: true, then: true, else: true };
  qn.arrayKeywords = { items: true, allOf: true, anyOf: true, oneOf: true };
  qn.propsKeywords = { $defs: true, definitions: true, properties: true, patternProperties: true, dependencies: true };
  qn.skipKeywords = { default: true, enum: true, const: true, required: true, maximum: true, minimum: true, exclusiveMaximum: true, exclusiveMinimum: true, multipleOf: true, maxLength: true, minLength: true, pattern: true, format: true, maxItems: true, minItems: true, uniqueItems: true, maxProperties: true, minProperties: true };
  function jm(e, t, r, o, n, i, s, a, c, u) {
    if (o && typeof o == "object" && !Array.isArray(o)) {
      t(o, n, i, s, a, c, u);
      for (var d in o) {
        var p = o[d];
        if (Array.isArray(p)) {
          if (d in qn.arrayKeywords) for (var f = 0; f < p.length; f++) jm(e, t, r, p[f], n + "/" + d + "/" + f, i, n, d, o, f);
        } else if (d in qn.propsKeywords) {
          if (p && typeof p == "object") for (var m in p) jm(e, t, r, p[m], n + "/" + d + "/" + w3(m), i, n, d, o, m);
        } else if (d in qn.keywords || e.allKeys && !(d in qn.skipKeywords)) jm(e, t, r, p, n + "/" + d, i, n, d, o);
      }
      r(o, n, i, s, a, c, u);
    }
  }
  function w3(e) {
    return e.replace(/~/g, "~0").replace(/\//g, "~1");
  }
});
var Fl = k((xC) => {
  Object.defineProperty(xC, "__esModule", { value: true });
  xC.getSchemaRefs = xC.resolveUrl = xC.normalizeId = xC._getFullPath = xC.getFullPath = xC.inlineRef = void 0;
  var k3 = ue(), E3 = qS(), P3 = bC(), T3 = /* @__PURE__ */ new Set(["type", "format", "pattern", "maxLength", "minLength", "maxProperties", "minProperties", "maxItems", "minItems", "maximum", "minimum", "uniqueItems", "multipleOf", "required", "enum", "const"]);
  function I3(e, t = true) {
    if (typeof e == "boolean") return true;
    if (t === true) return !VS(e);
    if (!t) return false;
    return _C(e) <= t;
  }
  xC.inlineRef = I3;
  var R3 = /* @__PURE__ */ new Set(["$ref", "$recursiveRef", "$recursiveAnchor", "$dynamicRef", "$dynamicAnchor"]);
  function VS(e) {
    for (let t in e) {
      if (R3.has(t)) return true;
      let r = e[t];
      if (Array.isArray(r) && r.some(VS)) return true;
      if (typeof r == "object" && VS(r)) return true;
    }
    return false;
  }
  function _C(e) {
    let t = 0;
    for (let r in e) {
      if (r === "$ref") return 1 / 0;
      if (t++, T3.has(r)) continue;
      if (typeof e[r] == "object") (0, k3.eachItem)(e[r], (o) => t += _C(o));
      if (t === 1 / 0) return 1 / 0;
    }
    return t;
  }
  function vC(e, t = "", r) {
    if (r !== false) t = ks(t);
    let o = e.parse(t);
    return SC(e, o);
  }
  xC.getFullPath = vC;
  function SC(e, t) {
    return e.serialize(t).split("#")[0] + "#";
  }
  xC._getFullPath = SC;
  var $3 = /#\/?$/;
  function ks(e) {
    return e ? e.replace($3, "") : "";
  }
  xC.normalizeId = ks;
  function A3(e, t, r) {
    return r = ks(r), e.resolve(t, r);
  }
  xC.resolveUrl = A3;
  var O3 = /^[a-z_][-a-z0-9._]*$/i;
  function C3(e, t) {
    if (typeof e == "boolean") return {};
    let { schemaId: r, uriResolver: o } = this.opts, n = ks(e[r] || t), i = { "": n }, s = vC(o, n, false), a = {}, c = /* @__PURE__ */ new Set();
    return P3(e, { allKeys: true }, (p, f, m, g) => {
      if (g === void 0) return;
      let h = s + f, y = i[g];
      if (typeof p[r] == "string") y = v.call(this, p[r]);
      w.call(this, p.$anchor), w.call(this, p.$dynamicAnchor), i[f] = y;
      function v(x) {
        let $ = this.opts.uriResolver.resolve;
        if (x = ks(y ? $(y, x) : x), c.has(x)) throw d(x);
        c.add(x);
        let U = this.refs[x];
        if (typeof U == "string") U = this.refs[U];
        if (typeof U == "object") u(p, U.schema, x);
        else if (x !== ks(h)) if (x[0] === "#") u(p, a[x], x), a[x] = p;
        else this.refs[x] = h;
        return x;
      }
      function w(x) {
        if (typeof x == "string") {
          if (!O3.test(x)) throw Error(`invalid anchor "${x}"`);
          v.call(this, `#${x}`);
        }
      }
    }), a;
    function u(p, f, m) {
      if (f !== void 0 && !E3(p, f)) throw d(m);
    }
    function d(p) {
      return Error(`reference "${p}" resolves to more than one schema`);
    }
  }
  xC.getSchemaRefs = C3;
});
var ql = k((UC) => {
  Object.defineProperty(UC, "__esModule", { value: true });
  UC.getData = UC.KeywordCxt = UC.validateFunctionCode = void 0;
  var IC = FO(), kC = Ll(), WS = jS(), Um = Ll(), z3 = rC(), Bl = dC(), ZS = gC(), q = re(), X = nn(), L3 = Fl(), on = ue(), Hl = zl();
  function F3(e) {
    if (AC(e)) {
      if (OC(e), $C(e)) {
        q3(e);
        return;
      }
    }
    RC(e, () => (0, IC.topBoolOrEmptySchema)(e));
  }
  UC.validateFunctionCode = F3;
  function RC({ gen: e, validateName: t, schema: r, schemaEnv: o, opts: n }, i) {
    if (n.code.es5) e.func(t, q._`${X.default.data}, ${X.default.valCxt}`, o.$async, () => {
      e.code(q._`"use strict"; ${EC(r, n)}`), B3(e, n), e.code(i);
    });
    else e.func(t, q._`${X.default.data}, ${H3(n)}`, o.$async, () => e.code(EC(r, n)).code(i));
  }
  function H3(e) {
    return q._`{${X.default.instancePath}="", ${X.default.parentData}, ${X.default.parentDataProperty}, ${X.default.rootData}=${X.default.data}${e.dynamicRef ? q._`, ${X.default.dynamicAnchors}={}` : q.nil}}={}`;
  }
  function B3(e, t) {
    e.if(X.default.valCxt, () => {
      if (e.var(X.default.instancePath, q._`${X.default.valCxt}.${X.default.instancePath}`), e.var(X.default.parentData, q._`${X.default.valCxt}.${X.default.parentData}`), e.var(X.default.parentDataProperty, q._`${X.default.valCxt}.${X.default.parentDataProperty}`), e.var(X.default.rootData, q._`${X.default.valCxt}.${X.default.rootData}`), t.dynamicRef) e.var(X.default.dynamicAnchors, q._`${X.default.valCxt}.${X.default.dynamicAnchors}`);
    }, () => {
      if (e.var(X.default.instancePath, q._`""`), e.var(X.default.parentData, q._`undefined`), e.var(X.default.parentDataProperty, q._`undefined`), e.var(X.default.rootData, X.default.data), t.dynamicRef) e.var(X.default.dynamicAnchors, q._`{}`);
    });
  }
  function q3(e) {
    let { schema: t, opts: r, gen: o } = e;
    RC(e, () => {
      if (r.$comment && t.$comment) MC(e);
      if (G3(e), o.let(X.default.vErrors, null), o.let(X.default.errors, 0), r.unevaluated) V3(e);
      CC(e), Y3(e);
    });
    return;
  }
  function V3(e) {
    let { gen: t, validateName: r } = e;
    e.evaluated = t.const("evaluated", q._`${r}.evaluated`), t.if(q._`${e.evaluated}.dynamicProps`, () => t.assign(q._`${e.evaluated}.props`, q._`undefined`)), t.if(q._`${e.evaluated}.dynamicItems`, () => t.assign(q._`${e.evaluated}.items`, q._`undefined`));
  }
  function EC(e, t) {
    let r = typeof e == "object" && e[t.schemaId];
    return r && (t.code.source || t.code.process) ? q._`/*# sourceURL=${r} */` : q.nil;
  }
  function Z3(e, t) {
    if (AC(e)) {
      if (OC(e), $C(e)) {
        W3(e, t);
        return;
      }
    }
    (0, IC.boolOrEmptySchema)(e, t);
  }
  function $C({ schema: e, self: t }) {
    if (typeof e == "boolean") return !e;
    for (let r in e) if (t.RULES.all[r]) return true;
    return false;
  }
  function AC(e) {
    return typeof e.schema != "boolean";
  }
  function W3(e, t) {
    let { schema: r, gen: o, opts: n } = e;
    if (n.$comment && r.$comment) MC(e);
    J3(e), X3(e);
    let i = o.const("_errs", X.default.errors);
    CC(e, i), o.var(t, q._`${i} === ${X.default.errors}`);
  }
  function OC(e) {
    (0, on.checkUnknownRules)(e), K3(e);
  }
  function CC(e, t) {
    if (e.opts.jtd) return PC(e, [], false, t);
    let r = (0, kC.getSchemaTypes)(e.schema), o = (0, kC.coerceAndCheckDataType)(e, r);
    PC(e, r, !o, t);
  }
  function K3(e) {
    let { schema: t, errSchemaPath: r, opts: o, self: n } = e;
    if (t.$ref && o.ignoreKeywordsWithRef && (0, on.schemaHasRulesButRef)(t, n.RULES)) n.logger.warn(`$ref: keywords ignored in schema at path "${r}"`);
  }
  function G3(e) {
    let { schema: t, opts: r } = e;
    if (t.default !== void 0 && r.useDefaults && r.strictSchema) (0, on.checkStrictMode)(e, "default is ignored in the schema root");
  }
  function J3(e) {
    let t = e.schema[e.opts.schemaId];
    if (t) e.baseId = (0, L3.resolveUrl)(e.opts.uriResolver, e.baseId, t);
  }
  function X3(e) {
    if (e.schema.$async && !e.schemaEnv.$async) throw Error("async schema in sync schema");
  }
  function MC({ gen: e, schemaEnv: t, schema: r, errSchemaPath: o, opts: n }) {
    let i = r.$comment;
    if (n.$comment === true) e.code(q._`${X.default.self}.logger.log(${i})`);
    else if (typeof n.$comment == "function") {
      let s = q.str`${o}/$comment`, a = e.scopeValue("root", { ref: t.root });
      e.code(q._`${X.default.self}.opts.$comment(${i}, ${s}, ${a}.schema)`);
    }
  }
  function Y3(e) {
    let { gen: t, schemaEnv: r, validateName: o, ValidationError: n, opts: i } = e;
    if (r.$async) t.if(q._`${X.default.errors} === 0`, () => t.return(X.default.data), () => t.throw(q._`new ${n}(${X.default.vErrors})`));
    else {
      if (t.assign(q._`${o}.errors`, X.default.vErrors), i.unevaluated) Q3(e);
      t.return(q._`${X.default.errors} === 0`);
    }
  }
  function Q3({ gen: e, evaluated: t, props: r, items: o }) {
    if (r instanceof q.Name) e.assign(q._`${t}.props`, r);
    if (o instanceof q.Name) e.assign(q._`${t}.items`, o);
  }
  function PC(e, t, r, o) {
    let { gen: n, schema: i, data: s, allErrors: a, opts: c, self: u } = e, { RULES: d } = u;
    if (i.$ref && (c.ignoreKeywordsWithRef || !(0, on.schemaHasRulesButRef)(i, d))) {
      n.block(() => NC(e, "$ref", d.all.$ref.definition));
      return;
    }
    if (!c.jtd) e8(e, t);
    n.block(() => {
      for (let f of d.rules) p(f);
      p(d.post);
    });
    function p(f) {
      if (!(0, WS.shouldUseGroup)(i, f)) return;
      if (f.type) {
        if (n.if((0, Um.checkDataType)(f.type, s, c.strictNumbers)), TC(e, f), t.length === 1 && t[0] === f.type && r) n.else(), (0, Um.reportTypeError)(e);
        n.endIf();
      } else TC(e, f);
      if (!a) n.if(q._`${X.default.errors} === ${o || 0}`);
    }
  }
  function TC(e, t) {
    let { gen: r, schema: o, opts: { useDefaults: n } } = e;
    if (n) (0, z3.assignDefaults)(e, t.type);
    r.block(() => {
      for (let i of t.rules) if ((0, WS.shouldUseRule)(o, i)) NC(e, i.keyword, i.definition, t.type);
    });
  }
  function e8(e, t) {
    if (e.schemaEnv.meta || !e.opts.strictTypes) return;
    if (t8(e, t), !e.opts.allowUnionTypes) r8(e, t);
    n8(e, e.dataTypes);
  }
  function t8(e, t) {
    if (!t.length) return;
    if (!e.dataTypes.length) {
      e.dataTypes = t;
      return;
    }
    t.forEach((r) => {
      if (!DC(e.dataTypes, r)) KS(e, `type "${r}" not allowed by context "${e.dataTypes.join(",")}"`);
    }), i8(e, t);
  }
  function r8(e, t) {
    if (t.length > 1 && !(t.length === 2 && t.includes("null"))) KS(e, "use allowUnionTypes to allow union type keyword");
  }
  function n8(e, t) {
    let r = e.self.RULES.all;
    for (let o in r) {
      let n = r[o];
      if (typeof n == "object" && (0, WS.shouldUseRule)(e.schema, n)) {
        let { type: i } = n.definition;
        if (i.length && !i.some((s) => o8(t, s))) KS(e, `missing type "${i.join(",")}" for keyword "${o}"`);
      }
    }
  }
  function o8(e, t) {
    return e.includes(t) || t === "number" && e.includes("integer");
  }
  function DC(e, t) {
    return e.includes(t) || t === "integer" && e.includes("number");
  }
  function i8(e, t) {
    let r = [];
    for (let o of e.dataTypes) if (DC(t, o)) r.push(o);
    else if (t.includes("integer") && o === "number") r.push("integer");
    e.dataTypes = r;
  }
  function KS(e, t) {
    let r = e.schemaEnv.baseId + e.errSchemaPath;
    t += ` at "${r}" (strictTypes)`, (0, on.checkStrictMode)(e, t, e.opts.strictTypes);
  }
  class GS {
    constructor(e, t, r) {
      if ((0, Bl.validateKeywordUsage)(e, t, r), this.gen = e.gen, this.allErrors = e.allErrors, this.keyword = r, this.data = e.data, this.schema = e.schema[r], this.$data = t.$data && e.opts.$data && this.schema && this.schema.$data, this.schemaValue = (0, on.schemaRefOrVal)(e, this.schema, r, this.$data), this.schemaType = t.schemaType, this.parentSchema = e.schema, this.params = {}, this.it = e, this.def = t, this.$data) this.schemaCode = e.gen.const("vSchema", jC(this.$data, e));
      else if (this.schemaCode = this.schemaValue, !(0, Bl.validSchemaType)(this.schema, t.schemaType, t.allowUndefined)) throw Error(`${r} value must be ${JSON.stringify(t.schemaType)}`);
      if ("code" in t ? t.trackErrors : t.errors !== false) this.errsCount = e.gen.const("_errs", X.default.errors);
    }
    result(e, t, r) {
      this.failResult((0, q.not)(e), t, r);
    }
    failResult(e, t, r) {
      if (this.gen.if(e), r) r();
      else this.error();
      if (t) {
        if (this.gen.else(), t(), this.allErrors) this.gen.endIf();
      } else if (this.allErrors) this.gen.endIf();
      else this.gen.else();
    }
    pass(e, t) {
      this.failResult((0, q.not)(e), void 0, t);
    }
    fail(e) {
      if (e === void 0) {
        if (this.error(), !this.allErrors) this.gen.if(false);
        return;
      }
      if (this.gen.if(e), this.error(), this.allErrors) this.gen.endIf();
      else this.gen.else();
    }
    fail$data(e) {
      if (!this.$data) return this.fail(e);
      let { schemaCode: t } = this;
      this.fail(q._`${t} !== undefined && (${(0, q.or)(this.invalid$data(), e)})`);
    }
    error(e, t, r) {
      if (t) {
        this.setParams(t), this._error(e, r), this.setParams({});
        return;
      }
      this._error(e, r);
    }
    _error(e, t) {
      (e ? Hl.reportExtraError : Hl.reportError)(this, this.def.error, t);
    }
    $dataError() {
      (0, Hl.reportError)(this, this.def.$dataError || Hl.keyword$DataError);
    }
    reset() {
      if (this.errsCount === void 0) throw Error('add "trackErrors" to keyword definition');
      (0, Hl.resetErrorsCount)(this.gen, this.errsCount);
    }
    ok(e) {
      if (!this.allErrors) this.gen.if(e);
    }
    setParams(e, t) {
      if (t) Object.assign(this.params, e);
      else this.params = e;
    }
    block$data(e, t, r = q.nil) {
      this.gen.block(() => {
        this.check$data(e, r), t();
      });
    }
    check$data(e = q.nil, t = q.nil) {
      if (!this.$data) return;
      let { gen: r, schemaCode: o, schemaType: n, def: i } = this;
      if (r.if((0, q.or)(q._`${o} === undefined`, t)), e !== q.nil) r.assign(e, true);
      if (n.length || i.validateSchema) {
        if (r.elseIf(this.invalid$data()), this.$dataError(), e !== q.nil) r.assign(e, false);
      }
      r.else();
    }
    invalid$data() {
      let { gen: e, schemaCode: t, schemaType: r, def: o, it: n } = this;
      return (0, q.or)(i(), s());
      function i() {
        if (r.length) {
          if (!(t instanceof q.Name)) throw Error("ajv implementation error");
          let a = Array.isArray(r) ? r : [r];
          return q._`${(0, Um.checkDataTypes)(a, t, n.opts.strictNumbers, Um.DataType.Wrong)}`;
        }
        return q.nil;
      }
      function s() {
        if (o.validateSchema) {
          let a = e.scopeValue("validate$data", { ref: o.validateSchema });
          return q._`!${a}(${t})`;
        }
        return q.nil;
      }
    }
    subschema(e, t) {
      let r = (0, ZS.getSubschema)(this.it, e);
      (0, ZS.extendSubschemaData)(r, this.it, e), (0, ZS.extendSubschemaMode)(r, e);
      let o = { ...this.it, ...r, items: void 0, props: void 0 };
      return Z3(o, t), o;
    }
    mergeEvaluated(e, t) {
      let { it: r, gen: o } = this;
      if (!r.opts.unevaluated) return;
      if (r.props !== true && e.props !== void 0) r.props = on.mergeEvaluated.props(o, e.props, r.props, t);
      if (r.items !== true && e.items !== void 0) r.items = on.mergeEvaluated.items(o, e.items, r.items, t);
    }
    mergeValidEvaluated(e, t) {
      let { it: r, gen: o } = this;
      if (r.opts.unevaluated && (r.props !== true || r.items !== true)) return o.if(t, () => this.mergeEvaluated(e, q.Name)), true;
    }
  }
  UC.KeywordCxt = GS;
  function NC(e, t, r, o) {
    let n = new GS(e, r, t);
    if ("code" in r) r.code(n, o);
    else if (n.$data && r.validate) (0, Bl.funcKeywordCode)(n, r);
    else if ("macro" in r) (0, Bl.macroKeywordCode)(n, r);
    else if (r.compile || r.validate) (0, Bl.funcKeywordCode)(n, r);
  }
  var s8 = /^\/(?:[^~]|~0|~1)*$/, a8 = /^([0-9]+)(#|\/(?:[^~]|~0|~1)*)?$/;
  function jC(e, { dataLevel: t, dataNames: r, dataPathArr: o }) {
    let n, i;
    if (e === "") return X.default.rootData;
    if (e[0] === "/") {
      if (!s8.test(e)) throw Error(`Invalid JSON-pointer: ${e}`);
      n = e, i = X.default.rootData;
    } else {
      let u = a8.exec(e);
      if (!u) throw Error(`Invalid JSON-pointer: ${e}`);
      let d = +u[1];
      if (n = u[2], n === "#") {
        if (d >= t) throw Error(c("property/index", d));
        return o[t - d];
      }
      if (d > t) throw Error(c("data", d));
      if (i = r[t - d], !n) return i;
    }
    let s = i, a = n.split("/");
    for (let u of a) if (u) i = q._`${i}${(0, q.getProperty)((0, on.unescapeJsonPointer)(u))}`, s = q._`${s} && ${i}`;
    return s;
    function c(u, d) {
      return `Cannot access ${u} ${d} levels up, current level is ${t}`;
    }
  }
  UC.getData = jC;
});
var zm = k((FC) => {
  Object.defineProperty(FC, "__esModule", { value: true });
  class LC extends Error {
    constructor(e) {
      super("validation failed");
      this.errors = e, this.ajv = this.validation = true;
    }
  }
  FC.default = LC;
});
var Vl = k((BC) => {
  Object.defineProperty(BC, "__esModule", { value: true });
  var JS = Fl();
  class HC extends Error {
    constructor(e, t, r, o) {
      super(o || `can't resolve reference ${r} from id ${t}`);
      this.missingRef = (0, JS.resolveUrl)(e, t, r), this.missingSchema = (0, JS.normalizeId)((0, JS.getFullPath)(e, this.missingRef));
    }
  }
  BC.default = HC;
});
var Fm = k((ZC) => {
  Object.defineProperty(ZC, "__esModule", { value: true });
  ZC.resolveSchema = ZC.getCompilingSchema = ZC.resolveRef = ZC.compileSchema = ZC.SchemaEnv = void 0;
  var yr = re(), p8 = zm(), Lo = nn(), br = Fl(), qC = ue(), f8 = ql();
  class Zl {
    constructor(e) {
      var t;
      this.refs = {}, this.dynamicAnchors = {};
      let r;
      if (typeof e.schema == "object") r = e.schema;
      this.schema = e.schema, this.schemaId = e.schemaId, this.root = e.root || this, this.baseId = (t = e.baseId) !== null && t !== void 0 ? t : (0, br.normalizeId)(r === null || r === void 0 ? void 0 : r[e.schemaId || "$id"]), this.schemaPath = e.schemaPath, this.localRefs = e.localRefs, this.meta = e.meta, this.$async = r === null || r === void 0 ? void 0 : r.$async, this.refs = {};
    }
  }
  ZC.SchemaEnv = Zl;
  function YS(e) {
    let t = VC.call(this, e);
    if (t) return t;
    let r = (0, br.getFullPath)(this.opts.uriResolver, e.root.baseId), { es5: o, lines: n } = this.opts.code, { ownProperties: i } = this.opts, s = new yr.CodeGen(this.scope, { es5: o, lines: n, ownProperties: i }), a;
    if (e.$async) a = s.scopeValue("Error", { ref: p8.default, code: yr._`require("ajv/dist/runtime/validation_error").default` });
    let c = s.scopeName("validate");
    e.validateName = c;
    let u = { gen: s, allErrors: this.opts.allErrors, data: Lo.default.data, parentData: Lo.default.parentData, parentDataProperty: Lo.default.parentDataProperty, dataNames: [Lo.default.data], dataPathArr: [yr.nil], dataLevel: 0, dataTypes: [], definedProperties: /* @__PURE__ */ new Set(), topSchemaRef: s.scopeValue("schema", this.opts.code.source === true ? { ref: e.schema, code: (0, yr.stringify)(e.schema) } : { ref: e.schema }), validateName: c, ValidationError: a, schema: e.schema, schemaEnv: e, rootId: r, baseId: e.baseId || r, schemaPath: yr.nil, errSchemaPath: e.schemaPath || (this.opts.jtd ? "" : "#"), errorPath: yr._`""`, opts: this.opts, self: this }, d;
    try {
      this._compilations.add(e), (0, f8.validateFunctionCode)(u), s.optimize(this.opts.code.optimize);
      let p = s.toString();
      if (d = `${s.scopeRefs(Lo.default.scope)}return ${p}`, this.opts.code.process) d = this.opts.code.process(d, e);
      let m = Function(`${Lo.default.self}`, `${Lo.default.scope}`, d)(this, this.scope.get());
      if (this.scope.value(c, { ref: m }), m.errors = null, m.schema = e.schema, m.schemaEnv = e, e.$async) m.$async = true;
      if (this.opts.code.source === true) m.source = { validateName: c, validateCode: p, scopeValues: s._values };
      if (this.opts.unevaluated) {
        let { props: g, items: h } = u;
        if (m.evaluated = { props: g instanceof yr.Name ? void 0 : g, items: h instanceof yr.Name ? void 0 : h, dynamicProps: g instanceof yr.Name, dynamicItems: h instanceof yr.Name }, m.source) m.source.evaluated = (0, yr.stringify)(m.evaluated);
      }
      return e.validate = m, e;
    } catch (p) {
      if (delete e.validate, delete e.validateName, d) this.logger.error("Error compiling schema, function code:", d);
      throw p;
    } finally {
      this._compilations.delete(e);
    }
  }
  ZC.compileSchema = YS;
  function m8(e, t, r) {
    var o;
    r = (0, br.resolveUrl)(this.opts.uriResolver, t, r);
    let n = e.refs[r];
    if (n) return n;
    let i = y8.call(this, e, r);
    if (i === void 0) {
      let s = (o = e.localRefs) === null || o === void 0 ? void 0 : o[r], { schemaId: a } = this.opts;
      if (s) i = new Zl({ schema: s, schemaId: a, root: e, baseId: t });
    }
    if (i === void 0) return;
    return e.refs[r] = g8.call(this, i);
  }
  ZC.resolveRef = m8;
  function g8(e) {
    if ((0, br.inlineRef)(e.schema, this.opts.inlineRefs)) return e.schema;
    return e.validate ? e : YS.call(this, e);
  }
  function VC(e) {
    for (let t of this._compilations) if (h8(t, e)) return t;
  }
  ZC.getCompilingSchema = VC;
  function h8(e, t) {
    return e.schema === t.schema && e.root === t.root && e.baseId === t.baseId;
  }
  function y8(e, t) {
    let r;
    while (typeof (r = this.refs[t]) == "string") t = r;
    return r || this.schemas[t] || Lm.call(this, e, t);
  }
  function Lm(e, t) {
    let r = this.opts.uriResolver.parse(t), o = (0, br._getFullPath)(this.opts.uriResolver, r), n = (0, br.getFullPath)(this.opts.uriResolver, e.baseId, void 0);
    if (Object.keys(e.schema).length > 0 && o === n) return XS.call(this, r, e);
    let i = (0, br.normalizeId)(o), s = this.refs[i] || this.schemas[i];
    if (typeof s == "string") {
      let a = Lm.call(this, e, s);
      if (typeof (a === null || a === void 0 ? void 0 : a.schema) !== "object") return;
      return XS.call(this, r, a);
    }
    if (typeof (s === null || s === void 0 ? void 0 : s.schema) !== "object") return;
    if (!s.validate) YS.call(this, s);
    if (i === (0, br.normalizeId)(t)) {
      let { schema: a } = s, { schemaId: c } = this.opts, u = a[c];
      if (u) n = (0, br.resolveUrl)(this.opts.uriResolver, n, u);
      return new Zl({ schema: a, schemaId: c, root: e, baseId: n });
    }
    return XS.call(this, r, s);
  }
  ZC.resolveSchema = Lm;
  var b8 = /* @__PURE__ */ new Set(["properties", "patternProperties", "enum", "dependencies", "definitions"]);
  function XS(e, { baseId: t, schema: r, root: o }) {
    var n;
    if (((n = e.fragment) === null || n === void 0 ? void 0 : n[0]) !== "/") return;
    for (let a of e.fragment.slice(1).split("/")) {
      if (typeof r === "boolean") return;
      let c = r[(0, qC.unescapeFragment)(a)];
      if (c === void 0) return;
      r = c;
      let u = typeof r === "object" && r[this.opts.schemaId];
      if (!b8.has(a) && u) t = (0, br.resolveUrl)(this.opts.uriResolver, t, u);
    }
    let i;
    if (typeof r != "boolean" && r.$ref && !(0, qC.schemaHasRulesButRef)(r, this.RULES)) {
      let a = (0, br.resolveUrl)(this.opts.uriResolver, t, r.$ref);
      i = Lm.call(this, o, a);
    }
    let { schemaId: s } = this.opts;
    if (i = i || new Zl({ schema: r, schemaId: s, root: o, baseId: t }), i.schema !== i.root.schema) return i;
    return;
  }
});
var KC = k((HPe, w8) => {
  w8.exports = { $id: "https://raw.githubusercontent.com/ajv-validator/ajv/master/lib/refs/data.json#", description: "Meta-schema for $data reference (JSON AnySchema extension proposal)", type: "object", required: ["$data"], properties: { $data: { type: "string", anyOf: [{ format: "relative-json-pointer" }, { format: "json-pointer" }] } }, additionalProperties: false };
});
var tx = k((BPe, eM) => {
  var k8 = RegExp.prototype.test.bind(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu), JC = RegExp.prototype.test.bind(/^(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)$/u), QS = RegExp.prototype.test.bind(/^[\da-f]{2}$/iu), XC = RegExp.prototype.test.bind(/^[\da-z\-._~]$/iu), E8 = RegExp.prototype.test.bind(/^[\da-z\-._~!$&'()*+,;=:@/]$/iu);
  function ex(e) {
    let t = "", r = 0, o = 0;
    for (o = 0; o < e.length; o++) {
      if (r = e[o].charCodeAt(0), r === 48) continue;
      if (!(r >= 48 && r <= 57 || r >= 65 && r <= 70 || r >= 97 && r <= 102)) return "";
      t += e[o];
      break;
    }
    for (o += 1; o < e.length; o++) {
      if (r = e[o].charCodeAt(0), !(r >= 48 && r <= 57 || r >= 65 && r <= 70 || r >= 97 && r <= 102)) return "";
      t += e[o];
    }
    return t;
  }
  var P8 = RegExp.prototype.test.bind(/[^!"$&'()*+,\-.;=_`a-z{}~]/u);
  function GC(e) {
    return e.length = 0, true;
  }
  function T8(e, t, r) {
    if (e.length) {
      let o = ex(e);
      if (o !== "") t.push(o);
      else return r.error = true, false;
      e.length = 0;
    }
    return true;
  }
  function I8(e) {
    let t = 0, r = { error: false, address: "", zone: "" }, o = [], n = [], i = false, s = false, a = T8;
    for (let c = 0; c < e.length; c++) {
      let u = e[c];
      if (u === "[" || u === "]") continue;
      if (u === ":") {
        if (i === true) s = true;
        if (!a(n, o, r)) break;
        if (++t > 7) {
          r.error = true;
          break;
        }
        if (c > 0 && e[c - 1] === ":") i = true;
        o.push(":");
        continue;
      } else if (u === "%") {
        if (!a(n, o, r)) break;
        a = GC;
      } else {
        n.push(u);
        continue;
      }
    }
    if (n.length) if (a === GC) r.zone = n.join("");
    else if (s) o.push(n.join(""));
    else o.push(ex(n));
    return r.address = o.join(""), r;
  }
  function YC(e) {
    if (R8(e, ":") < 2) return { host: e, isIPV6: false };
    let t = I8(e);
    if (!t.error) {
      let { address: r, address: o } = t;
      if (t.zone) r += "%" + t.zone, o += "%25" + t.zone;
      return { host: r, isIPV6: true, escapedHost: o };
    } else return { host: e, isIPV6: false };
  }
  function R8(e, t) {
    let r = 0;
    for (let o = 0; o < e.length; o++) if (e[o] === t) r++;
    return r;
  }
  function $8(e) {
    let t = e, r = [], o = -1, n = 0;
    while (n = t.length) {
      if (n === 1) if (t === ".") break;
      else if (t === "/") {
        r.push("/");
        break;
      } else {
        r.push(t);
        break;
      }
      else if (n === 2) {
        if (t[0] === ".") {
          if (t[1] === ".") break;
          else if (t[1] === "/") {
            t = t.slice(2);
            continue;
          }
        } else if (t[0] === "/") {
          if (t[1] === "." || t[1] === "/") {
            r.push("/");
            break;
          }
        }
      } else if (n === 3) {
        if (t === "/..") {
          if (r.length !== 0) r.pop();
          r.push("/");
          break;
        }
      }
      if (t[0] === ".") {
        if (t[1] === ".") {
          if (t[2] === "/") {
            t = t.slice(3);
            continue;
          }
        } else if (t[1] === "/") {
          t = t.slice(2);
          continue;
        }
      } else if (t[0] === "/") {
        if (t[1] === ".") {
          if (t[2] === "/") {
            t = t.slice(2);
            continue;
          } else if (t[2] === ".") {
            if (t[3] === "/") {
              if (t = t.slice(3), r.length !== 0) r.pop();
              continue;
            }
          }
        }
      }
      if ((o = t.indexOf("/", 1)) === -1) {
        r.push(t);
        break;
      } else r.push(t.slice(0, o)), t = t.slice(o);
    }
    return r.join("");
  }
  var A8 = { "@": "%40", "/": "%2F", "?": "%3F", "#": "%23", ":": "%3A" }, O8 = /[@/?#:]/g, C8 = /[@/?#]/g;
  function QC(e, t) {
    let r = t ? C8 : O8;
    return r.lastIndex = 0, e.replace(r, (o) => A8[o]);
  }
  function M8(e, t = false) {
    if (e.indexOf("%") === -1) return e;
    let r = "";
    for (let o = 0; o < e.length; o++) {
      if (e[o] === "%" && o + 2 < e.length) {
        let n = e.slice(o + 1, o + 3);
        if (QS(n)) {
          let i = n.toUpperCase(), s = String.fromCharCode(parseInt(i, 16));
          if (t && XC(s)) r += s;
          else r += "%" + i;
          o += 2;
          continue;
        }
      }
      r += e[o];
    }
    return r;
  }
  function D8(e) {
    let t = "";
    for (let r = 0; r < e.length; r++) {
      if (e[r] === "%" && r + 2 < e.length) {
        let o = e.slice(r + 1, r + 3);
        if (QS(o)) {
          let n = o.toUpperCase(), i = String.fromCharCode(parseInt(n, 16));
          if (i !== "." && XC(i)) t += i;
          else t += "%" + n;
          r += 2;
          continue;
        }
      }
      if (E8(e[r])) t += e[r];
      else t += escape(e[r]);
    }
    return t;
  }
  function N8(e) {
    let t = "";
    for (let r = 0; r < e.length; r++) {
      if (e[r] === "%" && r + 2 < e.length) {
        let o = e.slice(r + 1, r + 3);
        if (QS(o)) {
          t += "%" + o.toUpperCase(), r += 2;
          continue;
        }
      }
      t += escape(e[r]);
    }
    return t;
  }
  function j8(e) {
    let t = [];
    if (e.userinfo !== void 0) t.push(e.userinfo), t.push("@");
    if (e.host !== void 0) {
      let r = unescape(e.host);
      if (!JC(r)) {
        let o = YC(r);
        if (o.isIPV6 === true) r = `[${o.escapedHost}]`;
        else r = QC(r, false);
      }
      t.push(r);
    }
    if (typeof e.port === "number" || typeof e.port === "string") t.push(":"), t.push(String(e.port));
    return t.length ? t.join("") : void 0;
  }
  eM.exports = { nonSimpleDomain: P8, recomposeAuthority: j8, reescapeHostDelimiters: QC, normalizePercentEncoding: M8, normalizePathEncoding: D8, escapePreservingEscapes: N8, removeDotSegments: $8, isIPv4: JC, isUUID: k8, normalizeIPv6: YC, stringArrayToHexStripped: ex };
});
var iM = k((qPe, oM) => {
  var { isUUID: U8 } = tx(), z8 = /([\da-z][\d\-a-z]{0,31}):((?:[\w!$'()*+,\-.:;=@]|%[\da-f]{2})+)/iu, L8 = ["http", "https", "ws", "wss", "urn", "urn:uuid"];
  function F8(e) {
    return L8.indexOf(e) !== -1;
  }
  function rx(e) {
    if (e.secure === true) return true;
    else if (e.secure === false) return false;
    else if (e.scheme) return e.scheme.length === 3 && (e.scheme[0] === "w" || e.scheme[0] === "W") && (e.scheme[1] === "s" || e.scheme[1] === "S") && (e.scheme[2] === "s" || e.scheme[2] === "S");
    else return false;
  }
  function tM(e) {
    if (!e.host) e.error = e.error || "HTTP URIs must have a host.";
    return e;
  }
  function rM(e) {
    let t = String(e.scheme).toLowerCase() === "https";
    if (e.port === (t ? 443 : 80) || e.port === "") e.port = void 0;
    if (!e.path) e.path = "/";
    return e;
  }
  function H8(e) {
    return e.secure = rx(e), e.resourceName = (e.path || "/") + (e.query ? "?" + e.query : ""), e.path = void 0, e.query = void 0, e;
  }
  function B8(e) {
    if (e.port === (rx(e) ? 443 : 80) || e.port === "") e.port = void 0;
    if (typeof e.secure === "boolean") e.scheme = e.secure ? "wss" : "ws", e.secure = void 0;
    if (e.resourceName) {
      let [t, r] = e.resourceName.split("?");
      e.path = t && t !== "/" ? t : void 0, e.query = r, e.resourceName = void 0;
    }
    return e.fragment = void 0, e;
  }
  function q8(e, t) {
    if (!e.path) return e.error = "URN can not be parsed", e;
    let r = e.path.match(z8);
    if (r) {
      let o = t.scheme || e.scheme || "urn";
      e.nid = r[1].toLowerCase(), e.nss = r[2];
      let n = `${o}:${t.nid || e.nid}`, i = nx(n);
      if (e.path = void 0, i) e = i.parse(e, t);
    } else e.error = e.error || "URN can not be parsed.";
    return e;
  }
  function V8(e, t) {
    if (e.nid === void 0) throw Error("URN without nid cannot be serialized");
    let r = t.scheme || e.scheme || "urn", o = e.nid.toLowerCase(), n = `${r}:${t.nid || o}`, i = nx(n);
    if (i) e = i.serialize(e, t);
    let s = e, a = e.nss;
    return s.path = `${o || t.nid}:${a}`, t.skipEscape = true, s;
  }
  function Z8(e, t) {
    let r = e;
    if (r.uuid = r.nss, r.nss = void 0, !t.tolerant && (!r.uuid || !U8(r.uuid))) r.error = r.error || "UUID is not valid.";
    return r;
  }
  function W8(e) {
    let t = e;
    return t.nss = (e.uuid || "").toLowerCase(), t;
  }
  var nM = { scheme: "http", domainHost: true, parse: tM, serialize: rM }, K8 = { scheme: "https", domainHost: nM.domainHost, parse: tM, serialize: rM }, Hm = { scheme: "ws", domainHost: true, parse: H8, serialize: B8 }, G8 = { scheme: "wss", domainHost: Hm.domainHost, parse: Hm.parse, serialize: Hm.serialize }, J8 = { scheme: "urn", parse: q8, serialize: V8, skipNormalize: true }, X8 = { scheme: "urn:uuid", parse: Z8, serialize: W8, skipNormalize: true }, Bm = { http: nM, https: K8, ws: Hm, wss: G8, urn: J8, "urn:uuid": X8 };
  Object.setPrototypeOf(Bm, null);
  function nx(e) {
    return e && (Bm[e] || Bm[e.toLowerCase()]) || void 0;
  }
  oM.exports = { wsIsSecure: rx, SCHEMES: Bm, isValidSchemeName: F8, getSchemeHandler: nx };
});
var dM = k((VPe, qm) => {
  var { normalizeIPv6: Y8, removeDotSegments: Wl, recomposeAuthority: Q8, normalizePercentEncoding: eX, normalizePathEncoding: tX, escapePreservingEscapes: rX, reescapeHostDelimiters: nX, isIPv4: oX, nonSimpleDomain: iX } = tx(), { SCHEMES: sX, getSchemeHandler: aM } = iM();
  function aX(e, t) {
    if (typeof e === "string") e = pX(e, t);
    else if (typeof e === "object") e = Es(Fo(e, t), t);
    return e;
  }
  function cX(e, t, r) {
    let o = r ? Object.assign({ scheme: "null" }, r) : { scheme: "null" }, n = cM(Es(e, o), Es(t, o), o, true);
    return o.skipEscape = true, Fo(n, o);
  }
  function cM(e, t, r, o) {
    let n = {};
    if (!o) e = Es(Fo(e, r), r), t = Es(Fo(t, r), r);
    if (r = r || {}, !r.tolerant && t.scheme) n.scheme = t.scheme, n.userinfo = t.userinfo, n.host = t.host, n.port = t.port, n.path = Wl(t.path || ""), n.query = t.query;
    else {
      if (t.userinfo !== void 0 || t.host !== void 0 || t.port !== void 0) n.userinfo = t.userinfo, n.host = t.host, n.port = t.port, n.path = Wl(t.path || ""), n.query = t.query;
      else {
        if (!t.path) if (n.path = e.path, t.query !== void 0) n.query = t.query;
        else n.query = e.query;
        else {
          if (t.path[0] === "/") n.path = Wl(t.path);
          else {
            if ((e.userinfo !== void 0 || e.host !== void 0 || e.port !== void 0) && !e.path) n.path = "/" + t.path;
            else if (!e.path) n.path = t.path;
            else n.path = e.path.slice(0, e.path.lastIndexOf("/") + 1) + t.path;
            n.path = Wl(n.path);
          }
          n.query = t.query;
        }
        n.userinfo = e.userinfo, n.host = e.host, n.port = e.port;
      }
      n.scheme = e.scheme;
    }
    return n.fragment = t.fragment, n;
  }
  function lX(e, t, r) {
    let o = sM(e, r), n = sM(t, r);
    return o !== void 0 && n !== void 0 && o.toLowerCase() === n.toLowerCase();
  }
  function Fo(e, t) {
    let r = { host: e.host, scheme: e.scheme, userinfo: e.userinfo, port: e.port, path: e.path, query: e.query, nid: e.nid, nss: e.nss, uuid: e.uuid, fragment: e.fragment, reference: e.reference, resourceName: e.resourceName, secure: e.secure, error: "" }, o = Object.assign({}, t), n = [], i = aM(o.scheme || r.scheme);
    if (i && i.serialize) i.serialize(r, o);
    if (r.path !== void 0) if (!o.skipEscape) {
      if (r.path = rX(r.path), r.scheme !== void 0) r.path = r.path.split("%3A").join(":");
    } else r.path = eX(r.path);
    if (o.reference !== "suffix" && r.scheme) n.push(r.scheme, ":");
    let s = Q8(r);
    if (s !== void 0) {
      if (o.reference !== "suffix") n.push("//");
      if (n.push(s), r.path && r.path[0] !== "/") n.push("/");
    }
    if (r.path !== void 0) {
      let a = r.path;
      if (!o.absolutePath && (!i || !i.absolutePath)) a = Wl(a);
      if (s === void 0 && a[0] === "/" && a[1] === "/") a = "/%2F" + a.slice(2);
      n.push(a);
    }
    if (r.query !== void 0) n.push("?", r.query);
    if (r.fragment !== void 0) n.push("#", r.fragment);
    return n.join("");
  }
  var uX = /^(?:([^#/:?]+):)?(?:\/\/((?:([^#/?@]*)@)?(\[[^#/?\]]+\]|[^#/:?]*)(?::(\d*))?))?([^#?]*)(?:\?([^#]*))?(?:#((?:.|[\n\r])*))?/u;
  function dX(e, t) {
    if (t[2] !== void 0 && e.path && e.path[0] !== "/") return 'URI path must start with "/" when authority is present.';
    if (typeof e.port === "number" && (e.port < 0 || e.port > 65535)) return "URI port is malformed.";
    return;
  }
  function lM(e, t) {
    let r = Object.assign({}, t), o = { scheme: void 0, userinfo: void 0, host: "", port: void 0, path: "", query: void 0, fragment: void 0 }, n = false, i = false;
    if (r.reference === "suffix") if (r.scheme) e = r.scheme + ":" + e;
    else e = "//" + e;
    let s = e.match(uX);
    if (s) {
      if (o.scheme = s[1], o.userinfo = s[3], o.host = s[4], o.port = parseInt(s[5], 10), o.path = s[6] || "", o.query = s[7], o.fragment = s[8], isNaN(o.port)) o.port = s[5];
      let a = dX(o, s);
      if (a !== void 0) o.error = o.error || a, n = true;
      if (o.host) if (oX(o.host) === false) {
        let d = Y8(o.host);
        o.host = d.host.toLowerCase(), i = d.isIPV6;
      } else i = true;
      if (o.scheme === void 0 && o.userinfo === void 0 && o.host === void 0 && o.port === void 0 && o.query === void 0 && !o.path) o.reference = "same-document";
      else if (o.scheme === void 0) o.reference = "relative";
      else if (o.fragment === void 0) o.reference = "absolute";
      else o.reference = "uri";
      if (r.reference && r.reference !== "suffix" && r.reference !== o.reference) o.error = o.error || "URI is not a " + r.reference + " reference.";
      let c = aM(r.scheme || o.scheme);
      if (!r.unicodeSupport && (!c || !c.unicodeSupport)) {
        if (o.host && (r.domainHost || c && c.domainHost) && i === false && iX(o.host)) try {
          o.host = URL.domainToASCII(o.host.toLowerCase());
        } catch (u) {
          o.error = o.error || "Host's domain name can not be converted to ASCII: " + u;
        }
      }
      if (!c || c && !c.skipNormalize) {
        if (e.indexOf("%") !== -1) {
          if (o.scheme !== void 0) o.scheme = unescape(o.scheme);
          if (o.host !== void 0) o.host = nX(unescape(o.host), i);
        }
        if (o.path) o.path = tX(o.path);
        if (o.fragment) try {
          o.fragment = encodeURI(decodeURIComponent(o.fragment));
        } catch {
          o.error = o.error || "URI malformed";
        }
      }
      if (c && c.parse) c.parse(o, r);
    } else o.error = o.error || "URI can not be parsed.";
    return { parsed: o, malformedAuthorityOrPort: n };
  }
  function Es(e, t) {
    return lM(e, t).parsed;
  }
  function pX(e, t) {
    return uM(e, t).normalized;
  }
  function uM(e, t) {
    let { parsed: r, malformedAuthorityOrPort: o } = lM(e, t);
    return { normalized: o ? e : Fo(r, t), malformedAuthorityOrPort: o };
  }
  function sM(e, t) {
    if (typeof e === "string") {
      let { normalized: r, malformedAuthorityOrPort: o } = uM(e, t);
      return o ? void 0 : r;
    }
    if (typeof e === "object") return Fo(e, t);
  }
  var ox = { SCHEMES: sX, normalize: aX, resolve: cX, resolveComponent: cM, equal: lX, serialize: Fo, parse: Es };
  qm.exports = ox;
  qm.exports.default = ox;
  qm.exports.fastUri = ox;
});
var mM = k((fM) => {
  Object.defineProperty(fM, "__esModule", { value: true });
  var pM = dM();
  pM.code = 'require("ajv/dist/runtime/uri").default';
  fM.default = pM;
});
var xM = k((sn) => {
  Object.defineProperty(sn, "__esModule", { value: true });
  sn.CodeGen = sn.Name = sn.nil = sn.stringify = sn.str = sn._ = sn.KeywordCxt = void 0;
  var mX = ql();
  Object.defineProperty(sn, "KeywordCxt", { enumerable: true, get: function() {
    return mX.KeywordCxt;
  } });
  var Ps = re();
  Object.defineProperty(sn, "_", { enumerable: true, get: function() {
    return Ps._;
  } });
  Object.defineProperty(sn, "str", { enumerable: true, get: function() {
    return Ps.str;
  } });
  Object.defineProperty(sn, "stringify", { enumerable: true, get: function() {
    return Ps.stringify;
  } });
  Object.defineProperty(sn, "nil", { enumerable: true, get: function() {
    return Ps.nil;
  } });
  Object.defineProperty(sn, "Name", { enumerable: true, get: function() {
    return Ps.Name;
  } });
  Object.defineProperty(sn, "CodeGen", { enumerable: true, get: function() {
    return Ps.CodeGen;
  } });
  var gX = zm(), _M = Vl(), hX = NS(), Kl = Fm(), yX = re(), Gl = Fl(), Vm = Ll(), sx = ue(), gM = KC(), bX = mM(), vM = (e, t) => new RegExp(e, t);
  vM.code = "new RegExp";
  var _X = ["removeAdditional", "useDefaults", "coerceTypes"], vX = /* @__PURE__ */ new Set(["validate", "serialize", "parse", "wrapper", "root", "schema", "keyword", "pattern", "formats", "validate$data", "func", "obj", "Error"]), SX = { errorDataPath: "", format: "`validateFormats: false` can be used instead.", nullable: '"nullable" keyword is supported by default.', jsonPointers: "Deprecated jsPropertySyntax can be used instead.", extendRefs: "Deprecated ignoreKeywordsWithRef can be used instead.", missingRefs: "Pass empty schema with $id that should be ignored to ajv.addSchema.", processCode: "Use option `code: {process: (code, schemaEnv: object) => string}`", sourceCode: "Use option `code: {source: true}`", strictDefaults: "It is default now, see option `strict`.", strictKeywords: "It is default now, see option `strict`.", uniqueItems: '"uniqueItems" keyword is always validated.', unknownFormats: "Disable strict mode or pass `true` to `ajv.addFormat` (or `formats` option).", cache: "Map is used as cache, schema object as key.", serialize: "Map is used as cache, schema object as key.", ajvErrors: "It is default now." }, xX = { ignoreKeywordsWithRef: "", jsPropertySyntax: "", unicode: '"minLength"/"maxLength" account for unicode characters by default.' }, hM = 200;
  function wX(e) {
    var t, r, o, n, i, s, a, c, u, d, p, f, m, g, h, y, v, w, x, $, U, se, Le, Ye, Ft;
    let _t = e.strict, to = (t = e.code) === null || t === void 0 ? void 0 : t.optimize, Yo = to === true || to === void 0 ? 1 : to || 0, Ar = (o = (r = e.code) === null || r === void 0 ? void 0 : r.regExp) !== null && o !== void 0 ? o : vM, Fs = (n = e.uriResolver) !== null && n !== void 0 ? n : bX.default;
    return { strictSchema: (s = (i = e.strictSchema) !== null && i !== void 0 ? i : _t) !== null && s !== void 0 ? s : true, strictNumbers: (c = (a = e.strictNumbers) !== null && a !== void 0 ? a : _t) !== null && c !== void 0 ? c : true, strictTypes: (d = (u = e.strictTypes) !== null && u !== void 0 ? u : _t) !== null && d !== void 0 ? d : "log", strictTuples: (f = (p = e.strictTuples) !== null && p !== void 0 ? p : _t) !== null && f !== void 0 ? f : "log", strictRequired: (g = (m = e.strictRequired) !== null && m !== void 0 ? m : _t) !== null && g !== void 0 ? g : false, code: e.code ? { ...e.code, optimize: Yo, regExp: Ar } : { optimize: Yo, regExp: Ar }, loopRequired: (h = e.loopRequired) !== null && h !== void 0 ? h : hM, loopEnum: (y = e.loopEnum) !== null && y !== void 0 ? y : hM, meta: (v = e.meta) !== null && v !== void 0 ? v : true, messages: (w = e.messages) !== null && w !== void 0 ? w : true, inlineRefs: (x = e.inlineRefs) !== null && x !== void 0 ? x : true, schemaId: ($ = e.schemaId) !== null && $ !== void 0 ? $ : "$id", addUsedSchema: (U = e.addUsedSchema) !== null && U !== void 0 ? U : true, validateSchema: (se = e.validateSchema) !== null && se !== void 0 ? se : true, validateFormats: (Le = e.validateFormats) !== null && Le !== void 0 ? Le : true, unicodeRegExp: (Ye = e.unicodeRegExp) !== null && Ye !== void 0 ? Ye : true, int32range: (Ft = e.int32range) !== null && Ft !== void 0 ? Ft : true, uriResolver: Fs };
  }
  class Zm {
    constructor(e = {}) {
      this.schemas = {}, this.refs = {}, this.formats = {}, this._compilations = /* @__PURE__ */ new Set(), this._loading = {}, this._cache = /* @__PURE__ */ new Map(), e = this.opts = { ...e, ...wX(e) };
      let { es5: t, lines: r } = this.opts.code;
      this.scope = new yX.ValueScope({ scope: {}, prefixes: vX, es5: t, lines: r }), this.logger = RX(e.logger);
      let o = e.validateFormats;
      if (e.validateFormats = false, this.RULES = (0, hX.getRules)(), yM.call(this, SX, e, "NOT SUPPORTED"), yM.call(this, xX, e, "DEPRECATED", "warn"), this._metaOpts = TX.call(this), e.formats) EX.call(this);
      if (this._addVocabularies(), this._addDefaultMetaSchema(), e.keywords) PX.call(this, e.keywords);
      if (typeof e.meta == "object") this.addMetaSchema(e.meta);
      kX.call(this), e.validateFormats = o;
    }
    _addVocabularies() {
      this.addKeyword("$async");
    }
    _addDefaultMetaSchema() {
      let { $data: e, meta: t, schemaId: r } = this.opts, o = gM;
      if (r === "id") o = { ...gM }, o.id = o.$id, delete o.$id;
      if (t && e) this.addMetaSchema(o, o[r], false);
    }
    defaultMeta() {
      let { meta: e, schemaId: t } = this.opts;
      return this.opts.defaultMeta = typeof e == "object" ? e[t] || e : void 0;
    }
    validate(e, t) {
      let r;
      if (typeof e == "string") {
        if (r = this.getSchema(e), !r) throw Error(`no schema with key or ref "${e}"`);
      } else r = this.compile(e);
      let o = r(t);
      if (!("$async" in r)) this.errors = r.errors;
      return o;
    }
    compile(e, t) {
      let r = this._addSchema(e, t);
      return r.validate || this._compileSchemaEnv(r);
    }
    compileAsync(e, t) {
      if (typeof this.opts.loadSchema != "function") throw Error("options.loadSchema should be a function");
      let { loadSchema: r } = this.opts;
      return o.call(this, e, t);
      async function o(u, d) {
        await n.call(this, u.$schema);
        let p = this._addSchema(u, d);
        return p.validate || i.call(this, p);
      }
      async function n(u) {
        if (u && !this.getSchema(u)) await o.call(this, { $ref: u }, true);
      }
      async function i(u) {
        try {
          return this._compileSchemaEnv(u);
        } catch (d) {
          if (!(d instanceof _M.default)) throw d;
          return s.call(this, d), await a.call(this, d.missingSchema), i.call(this, u);
        }
      }
      function s({ missingSchema: u, missingRef: d }) {
        if (this.refs[u]) throw Error(`AnySchema ${u} is loaded but ${d} cannot be resolved`);
      }
      async function a(u) {
        let d = await c.call(this, u);
        if (!this.refs[u]) await n.call(this, d.$schema);
        if (!this.refs[u]) this.addSchema(d, u, t);
      }
      async function c(u) {
        let d = this._loading[u];
        if (d) return d;
        try {
          return await (this._loading[u] = r(u));
        } finally {
          delete this._loading[u];
        }
      }
    }
    addSchema(e, t, r, o = this.opts.validateSchema) {
      if (Array.isArray(e)) {
        for (let i of e) this.addSchema(i, void 0, r, o);
        return this;
      }
      let n;
      if (typeof e === "object") {
        let { schemaId: i } = this.opts;
        if (n = e[i], n !== void 0 && typeof n != "string") throw Error(`schema ${i} must be string`);
      }
      return t = (0, Gl.normalizeId)(t || n), this._checkUnique(t), this.schemas[t] = this._addSchema(e, r, t, o, true), this;
    }
    addMetaSchema(e, t, r = this.opts.validateSchema) {
      return this.addSchema(e, t, true, r), this;
    }
    validateSchema(e, t) {
      if (typeof e == "boolean") return true;
      let r;
      if (r = e.$schema, r !== void 0 && typeof r != "string") throw Error("$schema must be a string");
      if (r = r || this.opts.defaultMeta || this.defaultMeta(), !r) return this.logger.warn("meta-schema not available"), this.errors = null, true;
      let o = this.validate(r, e);
      if (!o && t) {
        let n = "schema is invalid: " + this.errorsText();
        if (this.opts.validateSchema === "log") this.logger.error(n);
        else throw Error(n);
      }
      return o;
    }
    getSchema(e) {
      let t;
      while (typeof (t = bM.call(this, e)) == "string") e = t;
      if (t === void 0) {
        let { schemaId: r } = this.opts, o = new Kl.SchemaEnv({ schema: {}, schemaId: r });
        if (t = Kl.resolveSchema.call(this, o, e), !t) return;
        this.refs[e] = t;
      }
      return t.validate || this._compileSchemaEnv(t);
    }
    removeSchema(e) {
      if (e instanceof RegExp) return this._removeAllSchemas(this.schemas, e), this._removeAllSchemas(this.refs, e), this;
      switch (typeof e) {
        case "undefined":
          return this._removeAllSchemas(this.schemas), this._removeAllSchemas(this.refs), this._cache.clear(), this;
        case "string": {
          let t = bM.call(this, e);
          if (typeof t == "object") this._cache.delete(t.schema);
          return delete this.schemas[e], delete this.refs[e], this;
        }
        case "object": {
          let t = e;
          this._cache.delete(t);
          let r = e[this.opts.schemaId];
          if (r) r = (0, Gl.normalizeId)(r), delete this.schemas[r], delete this.refs[r];
          return this;
        }
        default:
          throw Error("ajv.removeSchema: invalid parameter");
      }
    }
    addVocabulary(e) {
      for (let t of e) this.addKeyword(t);
      return this;
    }
    addKeyword(e, t) {
      let r;
      if (typeof e == "string") {
        if (r = e, typeof t == "object") this.logger.warn("these parameters are deprecated, see docs for addKeyword"), t.keyword = r;
      } else if (typeof e == "object" && t === void 0) {
        if (t = e, r = t.keyword, Array.isArray(r) && !r.length) throw Error("addKeywords: keyword must be string or non-empty array");
      } else throw Error("invalid addKeywords parameters");
      if (AX.call(this, r, t), !t) return (0, sx.eachItem)(r, (n) => ix.call(this, n)), this;
      CX.call(this, t);
      let o = { ...t, type: (0, Vm.getJSONTypes)(t.type), schemaType: (0, Vm.getJSONTypes)(t.schemaType) };
      return (0, sx.eachItem)(r, o.type.length === 0 ? (n) => ix.call(this, n, o) : (n) => o.type.forEach((i) => ix.call(this, n, o, i))), this;
    }
    getKeyword(e) {
      let t = this.RULES.all[e];
      return typeof t == "object" ? t.definition : !!t;
    }
    removeKeyword(e) {
      let { RULES: t } = this;
      delete t.keywords[e], delete t.all[e];
      for (let r of t.rules) {
        let o = r.rules.findIndex((n) => n.keyword === e);
        if (o >= 0) r.rules.splice(o, 1);
      }
      return this;
    }
    addFormat(e, t) {
      if (typeof t == "string") t = new RegExp(t);
      return this.formats[e] = t, this;
    }
    errorsText(e = this.errors, { separator: t = ", ", dataVar: r = "data" } = {}) {
      if (!e || e.length === 0) return "No errors";
      return e.map((o) => `${r}${o.instancePath} ${o.message}`).reduce((o, n) => o + t + n);
    }
    $dataMetaSchema(e, t) {
      let r = this.RULES.all;
      e = JSON.parse(JSON.stringify(e));
      for (let o of t) {
        let n = o.split("/").slice(1), i = e;
        for (let s of n) i = i[s];
        for (let s in r) {
          let a = r[s];
          if (typeof a != "object") continue;
          let { $data: c } = a.definition, u = i[s];
          if (c && u) i[s] = SM(u);
        }
      }
      return e;
    }
    _removeAllSchemas(e, t) {
      for (let r in e) {
        let o = e[r];
        if (!t || t.test(r)) {
          if (typeof o == "string") delete e[r];
          else if (o && !o.meta) this._cache.delete(o.schema), delete e[r];
        }
      }
    }
    _addSchema(e, t, r, o = this.opts.validateSchema, n = this.opts.addUsedSchema) {
      let i, { schemaId: s } = this.opts;
      if (typeof e == "object") i = e[s];
      else if (this.opts.jtd) throw Error("schema must be object");
      else if (typeof e != "boolean") throw Error("schema must be object or boolean");
      let a = this._cache.get(e);
      if (a !== void 0) return a;
      r = (0, Gl.normalizeId)(i || r);
      let c = Gl.getSchemaRefs.call(this, e, r);
      if (a = new Kl.SchemaEnv({ schema: e, schemaId: s, meta: t, baseId: r, localRefs: c }), this._cache.set(a.schema, a), n && !r.startsWith("#")) {
        if (r) this._checkUnique(r);
        this.refs[r] = a;
      }
      if (o) this.validateSchema(e, true);
      return a;
    }
    _checkUnique(e) {
      if (this.schemas[e] || this.refs[e]) throw Error(`schema with key or id "${e}" already exists`);
    }
    _compileSchemaEnv(e) {
      if (e.meta) this._compileMetaSchema(e);
      else Kl.compileSchema.call(this, e);
      if (!e.validate) throw Error("ajv implementation error");
      return e.validate;
    }
    _compileMetaSchema(e) {
      let t = this.opts;
      this.opts = this._metaOpts;
      try {
        Kl.compileSchema.call(this, e);
      } finally {
        this.opts = t;
      }
    }
  }
  Zm.ValidationError = gX.default;
  Zm.MissingRefError = _M.default;
  sn.default = Zm;
  function yM(e, t, r, o = "error") {
    for (let n in e) {
      let i = n;
      if (i in t) this.logger[o](`${r}: option ${n}. ${e[i]}`);
    }
  }
  function bM(e) {
    return e = (0, Gl.normalizeId)(e), this.schemas[e] || this.refs[e];
  }
  function kX() {
    let e = this.opts.schemas;
    if (!e) return;
    if (Array.isArray(e)) this.addSchema(e);
    else for (let t in e) this.addSchema(e[t], t);
  }
  function EX() {
    for (let e in this.opts.formats) {
      let t = this.opts.formats[e];
      if (t) this.addFormat(e, t);
    }
  }
  function PX(e) {
    if (Array.isArray(e)) {
      this.addVocabulary(e);
      return;
    }
    this.logger.warn("keywords option as map is deprecated, pass array");
    for (let t in e) {
      let r = e[t];
      if (!r.keyword) r.keyword = t;
      this.addKeyword(r);
    }
  }
  function TX() {
    let e = { ...this.opts };
    for (let t of _X) delete e[t];
    return e;
  }
  var IX = { log() {
  }, warn() {
  }, error() {
  } };
  function RX(e) {
    if (e === false) return IX;
    if (e === void 0) return console;
    if (e.log && e.warn && e.error) return e;
    throw Error("logger must implement log, warn and error methods");
  }
  var $X = /^[a-z_$][a-z0-9_$:-]*$/i;
  function AX(e, t) {
    let { RULES: r } = this;
    if ((0, sx.eachItem)(e, (o) => {
      if (r.keywords[o]) throw Error(`Keyword ${o} is already defined`);
      if (!$X.test(o)) throw Error(`Keyword ${o} has invalid name`);
    }), !t) return;
    if (t.$data && !("code" in t || "validate" in t)) throw Error('$data keyword must have "code" or "validate" function');
  }
  function ix(e, t, r) {
    var o;
    let n = t === null || t === void 0 ? void 0 : t.post;
    if (r && n) throw Error('keyword with "post" flag cannot have "type"');
    let { RULES: i } = this, s = n ? i.post : i.rules.find(({ type: c }) => c === r);
    if (!s) s = { type: r, rules: [] }, i.rules.push(s);
    if (i.keywords[e] = true, !t) return;
    let a = { keyword: e, definition: { ...t, type: (0, Vm.getJSONTypes)(t.type), schemaType: (0, Vm.getJSONTypes)(t.schemaType) } };
    if (t.before) OX.call(this, s, a, t.before);
    else s.rules.push(a);
    i.all[e] = a, (o = t.implements) === null || o === void 0 || o.forEach((c) => this.addKeyword(c));
  }
  function OX(e, t, r) {
    let o = e.rules.findIndex((n) => n.keyword === r);
    if (o >= 0) e.rules.splice(o, 0, t);
    else e.rules.push(t), this.logger.warn(`rule ${r} is not defined`);
  }
  function CX(e) {
    let { metaSchema: t } = e;
    if (t === void 0) return;
    if (e.$data && this.opts.$data) t = SM(t);
    e.validateSchema = this.compile(t, true);
  }
  var MX = { $ref: "https://raw.githubusercontent.com/ajv-validator/ajv/master/lib/refs/data.json#" };
  function SM(e) {
    return { anyOf: [e, MX] };
  }
});
var kM = k((wM) => {
  Object.defineProperty(wM, "__esModule", { value: true });
  var jX = { keyword: "id", code() {
    throw Error('NOT SUPPORTED: keyword "id", use "$id" for schema ID');
  } };
  wM.default = jX;
});
var $M = k((IM) => {
  Object.defineProperty(IM, "__esModule", { value: true });
  IM.callRef = IM.getValidate = void 0;
  var zX = Vl(), EM = rr(), Rt = re(), Ts = nn(), PM = Fm(), Wm = ue(), LX = { keyword: "$ref", schemaType: "string", code(e) {
    let { gen: t, schema: r, it: o } = e, { baseId: n, schemaEnv: i, validateName: s, opts: a, self: c } = o, { root: u } = i;
    if ((r === "#" || r === "#/") && n === u.baseId) return p();
    let d = PM.resolveRef.call(c, u, n, r);
    if (d === void 0) throw new zX.default(o.opts.uriResolver, n, r);
    if (d instanceof PM.SchemaEnv) return f(d);
    return m(d);
    function p() {
      if (i === u) return Km(e, s, i, i.$async);
      let g = t.scopeValue("root", { ref: u });
      return Km(e, Rt._`${g}.validate`, u, u.$async);
    }
    function f(g) {
      let h = TM(e, g);
      Km(e, h, g, g.$async);
    }
    function m(g) {
      let h = t.scopeValue("schema", a.code.source === true ? { ref: g, code: (0, Rt.stringify)(g) } : { ref: g }), y = t.name("valid"), v = e.subschema({ schema: g, dataTypes: [], schemaPath: Rt.nil, topSchemaRef: h, errSchemaPath: r }, y);
      e.mergeEvaluated(v), e.ok(y);
    }
  } };
  function TM(e, t) {
    let { gen: r } = e;
    return t.validate ? r.scopeValue("validate", { ref: t.validate }) : Rt._`${r.scopeValue("wrapper", { ref: t })}.validate`;
  }
  IM.getValidate = TM;
  function Km(e, t, r, o) {
    let { gen: n, it: i } = e, { allErrors: s, schemaEnv: a, opts: c } = i, u = c.passContext ? Ts.default.this : Rt.nil;
    if (o) d();
    else p();
    function d() {
      if (!a.$async) throw Error("async schema referenced by sync schema");
      let g = n.let("valid");
      n.try(() => {
        if (n.code(Rt._`await ${(0, EM.callValidateCode)(e, t, u)}`), m(t), !s) n.assign(g, true);
      }, (h) => {
        if (n.if(Rt._`!(${h} instanceof ${i.ValidationError})`, () => n.throw(h)), f(h), !s) n.assign(g, false);
      }), e.ok(g);
    }
    function p() {
      e.result((0, EM.callValidateCode)(e, t, u), () => m(t), () => f(t));
    }
    function f(g) {
      let h = Rt._`${g}.errors`;
      n.assign(Ts.default.vErrors, Rt._`${Ts.default.vErrors} === null ? ${h} : ${Ts.default.vErrors}.concat(${h})`), n.assign(Ts.default.errors, Rt._`${Ts.default.vErrors}.length`);
    }
    function m(g) {
      var h;
      if (!i.opts.unevaluated) return;
      let y = (h = r === null || r === void 0 ? void 0 : r.validate) === null || h === void 0 ? void 0 : h.evaluated;
      if (i.props !== true) if (y && !y.dynamicProps) {
        if (y.props !== void 0) i.props = Wm.mergeEvaluated.props(n, y.props, i.props);
      } else {
        let v = n.var("props", Rt._`${g}.evaluated.props`);
        i.props = Wm.mergeEvaluated.props(n, v, i.props, Rt.Name);
      }
      if (i.items !== true) if (y && !y.dynamicItems) {
        if (y.items !== void 0) i.items = Wm.mergeEvaluated.items(n, y.items, i.items);
      } else {
        let v = n.var("items", Rt._`${g}.evaluated.items`);
        i.items = Wm.mergeEvaluated.items(n, v, i.items, Rt.Name);
      }
    }
  }
  IM.callRef = Km;
  IM.default = LX;
});
var OM = k((AM) => {
  Object.defineProperty(AM, "__esModule", { value: true });
  var BX = kM(), qX = $M(), VX = ["$schema", "$id", "$defs", "$vocabulary", { keyword: "$comment" }, "definitions", BX.default, qX.default];
  AM.default = VX;
});
var MM = k((CM) => {
  Object.defineProperty(CM, "__esModule", { value: true });
  var Gm = re(), Vn = Gm.operators, Jm = { maximum: { okStr: "<=", ok: Vn.LTE, fail: Vn.GT }, minimum: { okStr: ">=", ok: Vn.GTE, fail: Vn.LT }, exclusiveMaximum: { okStr: "<", ok: Vn.LT, fail: Vn.GTE }, exclusiveMinimum: { okStr: ">", ok: Vn.GT, fail: Vn.LTE } }, WX = { message: ({ keyword: e, schemaCode: t }) => Gm.str`must be ${Jm[e].okStr} ${t}`, params: ({ keyword: e, schemaCode: t }) => Gm._`{comparison: ${Jm[e].okStr}, limit: ${t}}` }, KX = { keyword: Object.keys(Jm), type: "number", schemaType: "number", $data: true, error: WX, code(e) {
    let { keyword: t, data: r, schemaCode: o } = e;
    e.fail$data(Gm._`${r} ${Jm[t].fail} ${o} || isNaN(${r})`);
  } };
  CM.default = KX;
});
var NM = k((DM) => {
  Object.defineProperty(DM, "__esModule", { value: true });
  var Jl = re(), JX = { message: ({ schemaCode: e }) => Jl.str`must be multiple of ${e}`, params: ({ schemaCode: e }) => Jl._`{multipleOf: ${e}}` }, XX = { keyword: "multipleOf", type: "number", schemaType: "number", $data: true, error: JX, code(e) {
    let { gen: t, data: r, schemaCode: o, it: n } = e, i = n.opts.multipleOfPrecision, s = t.let("res"), a = i ? Jl._`Math.abs(Math.round(${s}) - ${s}) > 1e-${i}` : Jl._`${s} !== parseInt(${s})`;
    e.fail$data(Jl._`(${o} === 0 || (${s} = ${r}/${o}, ${a}))`);
  } };
  DM.default = XX;
});
var zM = k((UM) => {
  Object.defineProperty(UM, "__esModule", { value: true });
  function jM(e) {
    let t = e.length, r = 0, o = 0, n;
    while (o < t) if (r++, n = e.charCodeAt(o++), n >= 55296 && n <= 56319 && o < t) {
      if (n = e.charCodeAt(o), (n & 64512) === 56320) o++;
    }
    return r;
  }
  UM.default = jM;
  jM.code = 'require("ajv/dist/runtime/ucs2length").default';
});
var FM = k((LM) => {
  Object.defineProperty(LM, "__esModule", { value: true });
  var Ho = re(), eY = ue(), tY = zM(), rY = { message({ keyword: e, schemaCode: t }) {
    let r = e === "maxLength" ? "more" : "fewer";
    return Ho.str`must NOT have ${r} than ${t} characters`;
  }, params: ({ schemaCode: e }) => Ho._`{limit: ${e}}` }, nY = { keyword: ["maxLength", "minLength"], type: "string", schemaType: "number", $data: true, error: rY, code(e) {
    let { keyword: t, data: r, schemaCode: o, it: n } = e, i = t === "maxLength" ? Ho.operators.GT : Ho.operators.LT, s = n.opts.unicode === false ? Ho._`${r}.length` : Ho._`${(0, eY.useFunc)(e.gen, tY.default)}(${r})`;
    e.fail$data(Ho._`${s} ${i} ${o}`);
  } };
  LM.default = nY;
});
var BM = k((HM) => {
  Object.defineProperty(HM, "__esModule", { value: true });
  var iY = rr(), sY = ue(), Is = re(), aY = { message: ({ schemaCode: e }) => Is.str`must match pattern "${e}"`, params: ({ schemaCode: e }) => Is._`{pattern: ${e}}` }, cY = { keyword: "pattern", type: "string", schemaType: "string", $data: true, error: aY, code(e) {
    let { gen: t, data: r, $data: o, schema: n, schemaCode: i, it: s } = e, a = s.opts.unicodeRegExp ? "u" : "";
    if (o) {
      let { regExp: c } = s.opts.code, u = c.code === "new RegExp" ? Is._`new RegExp` : (0, sY.useFunc)(t, c), d = t.let("valid");
      t.try(() => t.assign(d, Is._`${u}(${i}, ${a}).test(${r})`), () => t.assign(d, false)), e.fail$data(Is._`!${d}`);
    } else {
      let c = (0, iY.usePattern)(e, n);
      e.fail$data(Is._`!${c}.test(${r})`);
    }
  } };
  HM.default = cY;
});
var VM = k((qM) => {
  Object.defineProperty(qM, "__esModule", { value: true });
  var Xl = re(), uY = { message({ keyword: e, schemaCode: t }) {
    let r = e === "maxProperties" ? "more" : "fewer";
    return Xl.str`must NOT have ${r} than ${t} properties`;
  }, params: ({ schemaCode: e }) => Xl._`{limit: ${e}}` }, dY = { keyword: ["maxProperties", "minProperties"], type: "object", schemaType: "number", $data: true, error: uY, code(e) {
    let { keyword: t, data: r, schemaCode: o } = e, n = t === "maxProperties" ? Xl.operators.GT : Xl.operators.LT;
    e.fail$data(Xl._`Object.keys(${r}).length ${n} ${o}`);
  } };
  qM.default = dY;
});
var WM = k((ZM) => {
  Object.defineProperty(ZM, "__esModule", { value: true });
  var Yl = rr(), Ql = re(), fY = ue(), mY = { message: ({ params: { missingProperty: e } }) => Ql.str`must have required property '${e}'`, params: ({ params: { missingProperty: e } }) => Ql._`{missingProperty: ${e}}` }, gY = { keyword: "required", type: "object", schemaType: "array", $data: true, error: mY, code(e) {
    let { gen: t, schema: r, schemaCode: o, data: n, $data: i, it: s } = e, { opts: a } = s;
    if (!i && r.length === 0) return;
    let c = r.length >= a.loopRequired;
    if (s.allErrors) u();
    else d();
    if (a.strictRequired) {
      let m = e.parentSchema.properties, { definedProperties: g } = e.it;
      for (let h of r) if ((m === null || m === void 0 ? void 0 : m[h]) === void 0 && !g.has(h)) {
        let y = s.schemaEnv.baseId + s.errSchemaPath, v = `required property "${h}" is not defined at "${y}" (strictRequired)`;
        (0, fY.checkStrictMode)(s, v, s.opts.strictRequired);
      }
    }
    function u() {
      if (c || i) e.block$data(Ql.nil, p);
      else for (let m of r) (0, Yl.checkReportMissingProp)(e, m);
    }
    function d() {
      let m = t.let("missing");
      if (c || i) {
        let g = t.let("valid", true);
        e.block$data(g, () => f(m, g)), e.ok(g);
      } else t.if((0, Yl.checkMissingProp)(e, r, m)), (0, Yl.reportMissingProp)(e, m), t.else();
    }
    function p() {
      t.forOf("prop", o, (m) => {
        e.setParams({ missingProperty: m }), t.if((0, Yl.noPropertyInData)(t, n, m, a.ownProperties), () => e.error());
      });
    }
    function f(m, g) {
      e.setParams({ missingProperty: m }), t.forOf(m, o, () => {
        t.assign(g, (0, Yl.propertyInData)(t, n, m, a.ownProperties)), t.if((0, Ql.not)(g), () => {
          e.error(), t.break();
        });
      }, Ql.nil);
    }
  } };
  ZM.default = gY;
});
var GM = k((KM) => {
  Object.defineProperty(KM, "__esModule", { value: true });
  var eu = re(), yY = { message({ keyword: e, schemaCode: t }) {
    let r = e === "maxItems" ? "more" : "fewer";
    return eu.str`must NOT have ${r} than ${t} items`;
  }, params: ({ schemaCode: e }) => eu._`{limit: ${e}}` }, bY = { keyword: ["maxItems", "minItems"], type: "array", schemaType: "number", $data: true, error: yY, code(e) {
    let { keyword: t, data: r, schemaCode: o } = e, n = t === "maxItems" ? eu.operators.GT : eu.operators.LT;
    e.fail$data(eu._`${r}.length ${n} ${o}`);
  } };
  KM.default = bY;
});
var Xm = k((XM) => {
  Object.defineProperty(XM, "__esModule", { value: true });
  var JM = qS();
  JM.code = 'require("ajv/dist/runtime/equal").default';
  XM.default = JM;
});
var QM = k((YM) => {
  Object.defineProperty(YM, "__esModule", { value: true });
  var ax = Ll(), nt = re(), SY = ue(), xY = Xm(), wY = { message: ({ params: { i: e, j: t } }) => nt.str`must NOT have duplicate items (items ## ${t} and ${e} are identical)`, params: ({ params: { i: e, j: t } }) => nt._`{i: ${e}, j: ${t}}` }, kY = { keyword: "uniqueItems", type: "array", schemaType: "boolean", $data: true, error: wY, code(e) {
    let { gen: t, data: r, $data: o, schema: n, parentSchema: i, schemaCode: s, it: a } = e;
    if (!o && !n) return;
    let c = t.let("valid"), u = i.items ? (0, ax.getSchemaTypes)(i.items) : [];
    e.block$data(c, d, nt._`${s} === false`), e.ok(c);
    function d() {
      let g = t.let("i", nt._`${r}.length`), h = t.let("j");
      e.setParams({ i: g, j: h }), t.assign(c, true), t.if(nt._`${g} > 1`, () => (p() ? f : m)(g, h));
    }
    function p() {
      return u.length > 0 && !u.some((g) => g === "object" || g === "array");
    }
    function f(g, h) {
      let y = t.name("item"), v = (0, ax.checkDataTypes)(u, y, a.opts.strictNumbers, ax.DataType.Wrong), w = t.const("indices", nt._`{}`);
      t.for(nt._`;${g}--;`, () => {
        if (t.let(y, nt._`${r}[${g}]`), t.if(v, nt._`continue`), u.length > 1) t.if(nt._`typeof ${y} == "string"`, nt._`${y} += "_"`);
        t.if(nt._`typeof ${w}[${y}] == "number"`, () => {
          t.assign(h, nt._`${w}[${y}]`), e.error(), t.assign(c, false).break();
        }).code(nt._`${w}[${y}] = ${g}`);
      });
    }
    function m(g, h) {
      let y = (0, SY.useFunc)(t, xY.default), v = t.name("outer");
      t.label(v).for(nt._`;${g}--;`, () => t.for(nt._`${h} = ${g}; ${h}--;`, () => t.if(nt._`${y}(${r}[${g}], ${r}[${h}])`, () => {
        e.error(), t.assign(c, false).break(v);
      })));
    }
  } };
  YM.default = kY;
});
var tD = k((eD) => {
  Object.defineProperty(eD, "__esModule", { value: true });
  var cx = re(), PY = ue(), TY = Xm(), IY = { message: "must be equal to constant", params: ({ schemaCode: e }) => cx._`{allowedValue: ${e}}` }, RY = { keyword: "const", $data: true, error: IY, code(e) {
    let { gen: t, data: r, $data: o, schemaCode: n, schema: i } = e;
    if (o || i && typeof i == "object") e.fail$data(cx._`!${(0, PY.useFunc)(t, TY.default)}(${r}, ${n})`);
    else e.fail(cx._`${i} !== ${r}`);
  } };
  eD.default = RY;
});
var nD = k((rD) => {
  Object.defineProperty(rD, "__esModule", { value: true });
  var tu = re(), AY = ue(), OY = Xm(), CY = { message: "must be equal to one of the allowed values", params: ({ schemaCode: e }) => tu._`{allowedValues: ${e}}` }, MY = { keyword: "enum", schemaType: "array", $data: true, error: CY, code(e) {
    let { gen: t, data: r, $data: o, schema: n, schemaCode: i, it: s } = e;
    if (!o && n.length === 0) throw Error("enum must have non-empty array");
    let a = n.length >= s.opts.loopEnum, c, u = () => c !== null && c !== void 0 ? c : c = (0, AY.useFunc)(t, OY.default), d;
    if (a || o) d = t.let("valid"), e.block$data(d, p);
    else {
      if (!Array.isArray(n)) throw Error("ajv implementation error");
      let m = t.const("vSchema", i);
      d = (0, tu.or)(...n.map((g, h) => f(m, h)));
    }
    e.pass(d);
    function p() {
      t.assign(d, false), t.forOf("v", i, (m) => t.if(tu._`${u()}(${r}, ${m})`, () => t.assign(d, true).break()));
    }
    function f(m, g) {
      let h = n[g];
      return typeof h === "object" && h !== null ? tu._`${u()}(${r}, ${m}[${g}])` : tu._`${r} === ${h}`;
    }
  } };
  rD.default = MY;
});
var iD = k((oD) => {
  Object.defineProperty(oD, "__esModule", { value: true });
  var NY = MM(), jY = NM(), UY = FM(), zY = BM(), LY = VM(), FY = WM(), HY = GM(), BY = QM(), qY = tD(), VY = nD(), ZY = [NY.default, jY.default, UY.default, zY.default, LY.default, FY.default, HY.default, BY.default, { keyword: "type", schemaType: ["string", "array"] }, { keyword: "nullable", schemaType: "boolean" }, qY.default, VY.default];
  oD.default = ZY;
});
var ux = k((aD) => {
  Object.defineProperty(aD, "__esModule", { value: true });
  aD.validateAdditionalItems = void 0;
  var Bo = re(), lx = ue(), KY = { message: ({ params: { len: e } }) => Bo.str`must NOT have more than ${e} items`, params: ({ params: { len: e } }) => Bo._`{limit: ${e}}` }, GY = { keyword: "additionalItems", type: "array", schemaType: ["boolean", "object"], before: "uniqueItems", error: KY, code(e) {
    let { parentSchema: t, it: r } = e, { items: o } = t;
    if (!Array.isArray(o)) {
      (0, lx.checkStrictMode)(r, '"additionalItems" is ignored when "items" is not an array of schemas');
      return;
    }
    sD(e, o);
  } };
  function sD(e, t) {
    let { gen: r, schema: o, data: n, keyword: i, it: s } = e;
    s.items = true;
    let a = r.const("len", Bo._`${n}.length`);
    if (o === false) e.setParams({ len: t.length }), e.pass(Bo._`${a} <= ${t.length}`);
    else if (typeof o == "object" && !(0, lx.alwaysValidSchema)(s, o)) {
      let u = r.var("valid", Bo._`${a} <= ${t.length}`);
      r.if((0, Bo.not)(u), () => c(u)), e.ok(u);
    }
    function c(u) {
      r.forRange("i", t.length, a, (d) => {
        if (e.subschema({ keyword: i, dataProp: d, dataPropType: lx.Type.Num }, u), !s.allErrors) r.if((0, Bo.not)(u), () => r.break());
      });
    }
  }
  aD.validateAdditionalItems = sD;
  aD.default = GY;
});
var dx = k((dD) => {
  Object.defineProperty(dD, "__esModule", { value: true });
  dD.validateTuple = void 0;
  var lD = re(), Ym = ue(), XY = rr(), YY = { keyword: "items", type: "array", schemaType: ["object", "array", "boolean"], before: "uniqueItems", code(e) {
    let { schema: t, it: r } = e;
    if (Array.isArray(t)) return uD(e, "additionalItems", t);
    if (r.items = true, (0, Ym.alwaysValidSchema)(r, t)) return;
    e.ok((0, XY.validateArray)(e));
  } };
  function uD(e, t, r = e.schema) {
    let { gen: o, parentSchema: n, data: i, keyword: s, it: a } = e;
    if (d(n), a.opts.unevaluated && r.length && a.items !== true) a.items = Ym.mergeEvaluated.items(o, r.length, a.items);
    let c = o.name("valid"), u = o.const("len", lD._`${i}.length`);
    r.forEach((p, f) => {
      if ((0, Ym.alwaysValidSchema)(a, p)) return;
      o.if(lD._`${u} > ${f}`, () => e.subschema({ keyword: s, schemaProp: f, dataProp: f }, c)), e.ok(c);
    });
    function d(p) {
      let { opts: f, errSchemaPath: m } = a, g = r.length, h = g === p.minItems && (g === p.maxItems || p[t] === false);
      if (f.strictTuples && !h) {
        let y = `"${s}" is ${g}-tuple, but minItems or maxItems/${t} are not specified or different at path "${m}"`;
        (0, Ym.checkStrictMode)(a, y, f.strictTuples);
      }
    }
  }
  dD.validateTuple = uD;
  dD.default = YY;
});
var mD = k((fD) => {
  Object.defineProperty(fD, "__esModule", { value: true });
  var e7 = dx(), t7 = { keyword: "prefixItems", type: "array", schemaType: ["array"], before: "uniqueItems", code: (e) => (0, e7.validateTuple)(e, "items") };
  fD.default = t7;
});
var yD = k((hD) => {
  Object.defineProperty(hD, "__esModule", { value: true });
  var gD = re(), n7 = ue(), o7 = rr(), i7 = ux(), s7 = { message: ({ params: { len: e } }) => gD.str`must NOT have more than ${e} items`, params: ({ params: { len: e } }) => gD._`{limit: ${e}}` }, a7 = { keyword: "items", type: "array", schemaType: ["object", "boolean"], before: "uniqueItems", error: s7, code(e) {
    let { schema: t, parentSchema: r, it: o } = e, { prefixItems: n } = r;
    if (o.items = true, (0, n7.alwaysValidSchema)(o, t)) return;
    if (n) (0, i7.validateAdditionalItems)(e, n);
    else e.ok((0, o7.validateArray)(e));
  } };
  hD.default = a7;
});
var _D = k((bD) => {
  Object.defineProperty(bD, "__esModule", { value: true });
  var nr = re(), Qm = ue(), l7 = { message: ({ params: { min: e, max: t } }) => t === void 0 ? nr.str`must contain at least ${e} valid item(s)` : nr.str`must contain at least ${e} and no more than ${t} valid item(s)`, params: ({ params: { min: e, max: t } }) => t === void 0 ? nr._`{minContains: ${e}}` : nr._`{minContains: ${e}, maxContains: ${t}}` }, u7 = { keyword: "contains", type: "array", schemaType: ["object", "boolean"], before: "uniqueItems", trackErrors: true, error: l7, code(e) {
    let { gen: t, schema: r, parentSchema: o, data: n, it: i } = e, s, a, { minContains: c, maxContains: u } = o;
    if (i.opts.next) s = c === void 0 ? 1 : c, a = u;
    else s = 1;
    let d = t.const("len", nr._`${n}.length`);
    if (e.setParams({ min: s, max: a }), a === void 0 && s === 0) {
      (0, Qm.checkStrictMode)(i, '"minContains" == 0 without "maxContains": "contains" keyword ignored');
      return;
    }
    if (a !== void 0 && s > a) {
      (0, Qm.checkStrictMode)(i, '"minContains" > "maxContains" is always invalid'), e.fail();
      return;
    }
    if ((0, Qm.alwaysValidSchema)(i, r)) {
      let h = nr._`${d} >= ${s}`;
      if (a !== void 0) h = nr._`${h} && ${d} <= ${a}`;
      e.pass(h);
      return;
    }
    i.items = true;
    let p = t.name("valid");
    if (a === void 0 && s === 1) m(p, () => t.if(p, () => t.break()));
    else if (s === 0) {
      if (t.let(p, true), a !== void 0) t.if(nr._`${n}.length > 0`, f);
    } else t.let(p, false), f();
    e.result(p, () => e.reset());
    function f() {
      let h = t.name("_valid"), y = t.let("count", 0);
      m(h, () => t.if(h, () => g(y)));
    }
    function m(h, y) {
      t.forRange("i", 0, d, (v) => {
        e.subschema({ keyword: "contains", dataProp: v, dataPropType: Qm.Type.Num, compositeRule: true }, h), y();
      });
    }
    function g(h) {
      if (t.code(nr._`${h}++`), a === void 0) t.if(nr._`${h} >= ${s}`, () => t.assign(p, true).break());
      else if (t.if(nr._`${h} > ${a}`, () => t.assign(p, false).break()), s === 1) t.assign(p, true);
      else t.if(nr._`${h} >= ${s}`, () => t.assign(p, true));
    }
  } };
  bD.default = u7;
});
var ED = k((xD) => {
  Object.defineProperty(xD, "__esModule", { value: true });
  xD.validateSchemaDeps = xD.validatePropertyDeps = xD.error = void 0;
  var px = re(), p7 = ue(), ru = rr();
  xD.error = { message: ({ params: { property: e, depsCount: t, deps: r } }) => {
    let o = t === 1 ? "property" : "properties";
    return px.str`must have ${o} ${r} when property ${e} is present`;
  }, params: ({ params: { property: e, depsCount: t, deps: r, missingProperty: o } }) => px._`{property: ${e},
    missingProperty: ${o},
    depsCount: ${t},
    deps: ${r}}` };
  var f7 = { keyword: "dependencies", type: "object", schemaType: "object", error: xD.error, code(e) {
    let [t, r] = m7(e);
    vD(e, t), SD(e, r);
  } };
  function m7({ schema: e }) {
    let t = {}, r = {};
    for (let o in e) {
      if (o === "__proto__") continue;
      let n = Array.isArray(e[o]) ? t : r;
      n[o] = e[o];
    }
    return [t, r];
  }
  function vD(e, t = e.schema) {
    let { gen: r, data: o, it: n } = e;
    if (Object.keys(t).length === 0) return;
    let i = r.let("missing");
    for (let s in t) {
      let a = t[s];
      if (a.length === 0) continue;
      let c = (0, ru.propertyInData)(r, o, s, n.opts.ownProperties);
      if (e.setParams({ property: s, depsCount: a.length, deps: a.join(", ") }), n.allErrors) r.if(c, () => {
        for (let u of a) (0, ru.checkReportMissingProp)(e, u);
      });
      else r.if(px._`${c} && (${(0, ru.checkMissingProp)(e, a, i)})`), (0, ru.reportMissingProp)(e, i), r.else();
    }
  }
  xD.validatePropertyDeps = vD;
  function SD(e, t = e.schema) {
    let { gen: r, data: o, keyword: n, it: i } = e, s = r.name("valid");
    for (let a in t) {
      if ((0, p7.alwaysValidSchema)(i, t[a])) continue;
      r.if((0, ru.propertyInData)(r, o, a, i.opts.ownProperties), () => {
        let c = e.subschema({ keyword: n, schemaProp: a }, s);
        e.mergeValidEvaluated(c, s);
      }, () => r.var(s, true)), e.ok(s);
    }
  }
  xD.validateSchemaDeps = SD;
  xD.default = f7;
});
var ID = k((TD) => {
  Object.defineProperty(TD, "__esModule", { value: true });
  var PD = re(), y7 = ue(), b7 = { message: "property name must be valid", params: ({ params: e }) => PD._`{propertyName: ${e.propertyName}}` }, _7 = { keyword: "propertyNames", type: "object", schemaType: ["object", "boolean"], error: b7, code(e) {
    let { gen: t, schema: r, data: o, it: n } = e;
    if ((0, y7.alwaysValidSchema)(n, r)) return;
    let i = t.name("valid");
    t.forIn("key", o, (s) => {
      e.setParams({ propertyName: s }), e.subschema({ keyword: "propertyNames", data: s, dataTypes: ["string"], propertyName: s, compositeRule: true }, i), t.if((0, PD.not)(i), () => {
        if (e.error(true), !n.allErrors) t.break();
      });
    }), e.ok(i);
  } };
  TD.default = _7;
});
var fx = k((RD) => {
  Object.defineProperty(RD, "__esModule", { value: true });
  var eg = rr(), _r = re(), S7 = nn(), tg = ue(), x7 = { message: "must NOT have additional properties", params: ({ params: e }) => _r._`{additionalProperty: ${e.additionalProperty}}` }, w7 = { keyword: "additionalProperties", type: ["object"], schemaType: ["boolean", "object"], allowUndefined: true, trackErrors: true, error: x7, code(e) {
    let { gen: t, schema: r, parentSchema: o, data: n, errsCount: i, it: s } = e;
    if (!i) throw Error("ajv implementation error");
    let { allErrors: a, opts: c } = s;
    if (s.props = true, c.removeAdditional !== "all" && (0, tg.alwaysValidSchema)(s, r)) return;
    let u = (0, eg.allSchemaProperties)(o.properties), d = (0, eg.allSchemaProperties)(o.patternProperties);
    p(), e.ok(_r._`${i} === ${S7.default.errors}`);
    function p() {
      t.forIn("key", n, (y) => {
        if (!u.length && !d.length) g(y);
        else t.if(f(y), () => g(y));
      });
    }
    function f(y) {
      let v;
      if (u.length > 8) {
        let w = (0, tg.schemaRefOrVal)(s, o.properties, "properties");
        v = (0, eg.isOwnProperty)(t, w, y);
      } else if (u.length) v = (0, _r.or)(...u.map((w) => _r._`${y} === ${w}`));
      else v = _r.nil;
      if (d.length) v = (0, _r.or)(v, ...d.map((w) => _r._`${(0, eg.usePattern)(e, w)}.test(${y})`));
      return (0, _r.not)(v);
    }
    function m(y) {
      t.code(_r._`delete ${n}[${y}]`);
    }
    function g(y) {
      if (c.removeAdditional === "all" || c.removeAdditional && r === false) {
        m(y);
        return;
      }
      if (r === false) {
        if (e.setParams({ additionalProperty: y }), e.error(), !a) t.break();
        return;
      }
      if (typeof r == "object" && !(0, tg.alwaysValidSchema)(s, r)) {
        let v = t.name("valid");
        if (c.removeAdditional === "failing") h(y, v, false), t.if((0, _r.not)(v), () => {
          e.reset(), m(y);
        });
        else if (h(y, v), !a) t.if((0, _r.not)(v), () => t.break());
      }
    }
    function h(y, v, w) {
      let x = { keyword: "additionalProperties", dataProp: y, dataPropType: tg.Type.Str };
      if (w === false) Object.assign(x, { compositeRule: true, createErrors: false, allErrors: false });
      e.subschema(x, v);
    }
  } };
  RD.default = w7;
});
var CD = k((OD) => {
  Object.defineProperty(OD, "__esModule", { value: true });
  var E7 = ql(), $D = rr(), mx = ue(), AD = fx(), P7 = { keyword: "properties", type: "object", schemaType: "object", code(e) {
    let { gen: t, schema: r, parentSchema: o, data: n, it: i } = e;
    if (i.opts.removeAdditional === "all" && o.additionalProperties === void 0) AD.default.code(new E7.KeywordCxt(i, AD.default, "additionalProperties"));
    let s = (0, $D.allSchemaProperties)(r);
    for (let p of s) i.definedProperties.add(p);
    if (i.opts.unevaluated && s.length && i.props !== true) i.props = mx.mergeEvaluated.props(t, (0, mx.toHash)(s), i.props);
    let a = s.filter((p) => !(0, mx.alwaysValidSchema)(i, r[p]));
    if (a.length === 0) return;
    let c = t.name("valid");
    for (let p of a) {
      if (u(p)) d(p);
      else {
        if (t.if((0, $D.propertyInData)(t, n, p, i.opts.ownProperties)), d(p), !i.allErrors) t.else().var(c, true);
        t.endIf();
      }
      e.it.definedProperties.add(p), e.ok(c);
    }
    function u(p) {
      return i.opts.useDefaults && !i.compositeRule && r[p].default !== void 0;
    }
    function d(p) {
      e.subschema({ keyword: "properties", schemaProp: p, dataProp: p }, c);
    }
  } };
  OD.default = P7;
});
var UD = k((jD) => {
  Object.defineProperty(jD, "__esModule", { value: true });
  var MD = rr(), rg = re(), DD = ue(), ND = ue(), I7 = { keyword: "patternProperties", type: "object", schemaType: "object", code(e) {
    let { gen: t, schema: r, data: o, parentSchema: n, it: i } = e, { opts: s } = i, a = (0, MD.allSchemaProperties)(r), c = a.filter((h) => (0, DD.alwaysValidSchema)(i, r[h]));
    if (a.length === 0 || c.length === a.length && (!i.opts.unevaluated || i.props === true)) return;
    let u = s.strictSchema && !s.allowMatchingProperties && n.properties, d = t.name("valid");
    if (i.props !== true && !(i.props instanceof rg.Name)) i.props = (0, ND.evaluatedPropsToName)(t, i.props);
    let { props: p } = i;
    f();
    function f() {
      for (let h of a) {
        if (u) m(h);
        if (i.allErrors) g(h);
        else t.var(d, true), g(h), t.if(d);
      }
    }
    function m(h) {
      for (let y in u) if (new RegExp(h).test(y)) (0, DD.checkStrictMode)(i, `property ${y} matches pattern ${h} (use allowMatchingProperties)`);
    }
    function g(h) {
      t.forIn("key", o, (y) => {
        t.if(rg._`${(0, MD.usePattern)(e, h)}.test(${y})`, () => {
          let v = c.includes(h);
          if (!v) e.subschema({ keyword: "patternProperties", schemaProp: h, dataProp: y, dataPropType: ND.Type.Str }, d);
          if (i.opts.unevaluated && p !== true) t.assign(rg._`${p}[${y}]`, true);
          else if (!v && !i.allErrors) t.if((0, rg.not)(d), () => t.break());
        });
      });
    }
  } };
  jD.default = I7;
});
var LD = k((zD) => {
  Object.defineProperty(zD, "__esModule", { value: true });
  var $7 = ue(), A7 = { keyword: "not", schemaType: ["object", "boolean"], trackErrors: true, code(e) {
    let { gen: t, schema: r, it: o } = e;
    if ((0, $7.alwaysValidSchema)(o, r)) {
      e.fail();
      return;
    }
    let n = t.name("valid");
    e.subschema({ keyword: "not", compositeRule: true, createErrors: false, allErrors: false }, n), e.failResult(n, () => e.reset(), () => e.error());
  }, error: { message: "must NOT be valid" } };
  zD.default = A7;
});
var HD = k((FD) => {
  Object.defineProperty(FD, "__esModule", { value: true });
  var C7 = rr(), M7 = { keyword: "anyOf", schemaType: "array", trackErrors: true, code: C7.validateUnion, error: { message: "must match a schema in anyOf" } };
  FD.default = M7;
});
var qD = k((BD) => {
  Object.defineProperty(BD, "__esModule", { value: true });
  var ng = re(), N7 = ue(), j7 = { message: "must match exactly one schema in oneOf", params: ({ params: e }) => ng._`{passingSchemas: ${e.passing}}` }, U7 = { keyword: "oneOf", schemaType: "array", trackErrors: true, error: j7, code(e) {
    let { gen: t, schema: r, parentSchema: o, it: n } = e;
    if (!Array.isArray(r)) throw Error("ajv implementation error");
    if (n.opts.discriminator && o.discriminator) return;
    let i = r, s = t.let("valid", false), a = t.let("passing", null), c = t.name("_valid");
    e.setParams({ passing: a }), t.block(u), e.result(s, () => e.reset(), () => e.error(true));
    function u() {
      i.forEach((d, p) => {
        let f;
        if ((0, N7.alwaysValidSchema)(n, d)) t.var(c, true);
        else f = e.subschema({ keyword: "oneOf", schemaProp: p, compositeRule: true }, c);
        if (p > 0) t.if(ng._`${c} && ${s}`).assign(s, false).assign(a, ng._`[${a}, ${p}]`).else();
        t.if(c, () => {
          if (t.assign(s, true), t.assign(a, p), f) e.mergeEvaluated(f, ng.Name);
        });
      });
    }
  } };
  BD.default = U7;
});
var ZD = k((VD) => {
  Object.defineProperty(VD, "__esModule", { value: true });
  var L7 = ue(), F7 = { keyword: "allOf", schemaType: "array", code(e) {
    let { gen: t, schema: r, it: o } = e;
    if (!Array.isArray(r)) throw Error("ajv implementation error");
    let n = t.name("valid");
    r.forEach((i, s) => {
      if ((0, L7.alwaysValidSchema)(o, i)) return;
      let a = e.subschema({ keyword: "allOf", schemaProp: s }, n);
      e.ok(n), e.mergeEvaluated(a);
    });
  } };
  VD.default = F7;
});
var JD = k((GD) => {
  Object.defineProperty(GD, "__esModule", { value: true });
  var og = re(), KD = ue(), B7 = { message: ({ params: e }) => og.str`must match "${e.ifClause}" schema`, params: ({ params: e }) => og._`{failingKeyword: ${e.ifClause}}` }, q7 = { keyword: "if", schemaType: ["object", "boolean"], trackErrors: true, error: B7, code(e) {
    let { gen: t, parentSchema: r, it: o } = e;
    if (r.then === void 0 && r.else === void 0) (0, KD.checkStrictMode)(o, '"if" without "then" and "else" is ignored');
    let n = WD(o, "then"), i = WD(o, "else");
    if (!n && !i) return;
    let s = t.let("valid", true), a = t.name("_valid");
    if (c(), e.reset(), n && i) {
      let d = t.let("ifClause");
      e.setParams({ ifClause: d }), t.if(a, u("then", d), u("else", d));
    } else if (n) t.if(a, u("then"));
    else t.if((0, og.not)(a), u("else"));
    e.pass(s, () => e.error(true));
    function c() {
      let d = e.subschema({ keyword: "if", compositeRule: true, createErrors: false, allErrors: false }, a);
      e.mergeEvaluated(d);
    }
    function u(d, p) {
      return () => {
        let f = e.subschema({ keyword: d }, a);
        if (t.assign(s, a), e.mergeValidEvaluated(f, s), p) t.assign(p, og._`${d}`);
        else e.setParams({ ifClause: d });
      };
    }
  } };
  function WD(e, t) {
    let r = e.schema[t];
    return r !== void 0 && !(0, KD.alwaysValidSchema)(e, r);
  }
  GD.default = q7;
});
var YD = k((XD) => {
  Object.defineProperty(XD, "__esModule", { value: true });
  var Z7 = ue(), W7 = { keyword: ["then", "else"], schemaType: ["object", "boolean"], code({ keyword: e, parentSchema: t, it: r }) {
    if (t.if === void 0) (0, Z7.checkStrictMode)(r, `"${e}" without "if" is ignored`);
  } };
  XD.default = W7;
});
var eN = k((QD) => {
  Object.defineProperty(QD, "__esModule", { value: true });
  var G7 = ux(), J7 = mD(), X7 = dx(), Y7 = yD(), Q7 = _D(), eQ = ED(), tQ = ID(), rQ = fx(), nQ = CD(), oQ = UD(), iQ = LD(), sQ = HD(), aQ = qD(), cQ = ZD(), lQ = JD(), uQ = YD();
  function dQ(e = false) {
    let t = [iQ.default, sQ.default, aQ.default, cQ.default, lQ.default, uQ.default, tQ.default, rQ.default, eQ.default, nQ.default, oQ.default];
    if (e) t.push(J7.default, Y7.default);
    else t.push(G7.default, X7.default);
    return t.push(Q7.default), t;
  }
  QD.default = dQ;
});
var rN = k((tN) => {
  Object.defineProperty(tN, "__esModule", { value: true });
  var qe = re(), fQ = { message: ({ schemaCode: e }) => qe.str`must match format "${e}"`, params: ({ schemaCode: e }) => qe._`{format: ${e}}` }, mQ = { keyword: "format", type: ["number", "string"], schemaType: "string", $data: true, error: fQ, code(e, t) {
    let { gen: r, data: o, $data: n, schema: i, schemaCode: s, it: a } = e, { opts: c, errSchemaPath: u, schemaEnv: d, self: p } = a;
    if (!c.validateFormats) return;
    if (n) f();
    else m();
    function f() {
      let g = r.scopeValue("formats", { ref: p.formats, code: c.code.formats }), h = r.const("fDef", qe._`${g}[${s}]`), y = r.let("fType"), v = r.let("format");
      r.if(qe._`typeof ${h} == "object" && !(${h} instanceof RegExp)`, () => r.assign(y, qe._`${h}.type || "string"`).assign(v, qe._`${h}.validate`), () => r.assign(y, qe._`"string"`).assign(v, h)), e.fail$data((0, qe.or)(w(), x()));
      function w() {
        if (c.strictSchema === false) return qe.nil;
        return qe._`${s} && !${v}`;
      }
      function x() {
        let $ = d.$async ? qe._`(${h}.async ? await ${v}(${o}) : ${v}(${o}))` : qe._`${v}(${o})`, U = qe._`(typeof ${v} == "function" ? ${$} : ${v}.test(${o}))`;
        return qe._`${v} && ${v} !== true && ${y} === ${t} && !${U}`;
      }
    }
    function m() {
      let g = p.formats[i];
      if (!g) {
        w();
        return;
      }
      if (g === true) return;
      let [h, y, v] = x(g);
      if (h === t) e.pass($());
      function w() {
        if (c.strictSchema === false) {
          p.logger.warn(U());
          return;
        }
        throw Error(U());
        function U() {
          return `unknown format "${i}" ignored in schema at path "${u}"`;
        }
      }
      function x(U) {
        let se = U instanceof RegExp ? (0, qe.regexpCode)(U) : c.code.formats ? qe._`${c.code.formats}${(0, qe.getProperty)(i)}` : void 0, Le = r.scopeValue("formats", { key: i, ref: U, code: se });
        if (typeof U == "object" && !(U instanceof RegExp)) return [U.type || "string", U.validate, qe._`${Le}.validate`];
        return ["string", U, Le];
      }
      function $() {
        if (typeof g == "object" && !(g instanceof RegExp) && g.async) {
          if (!d.$async) throw Error("async format in sync schema");
          return qe._`await ${v}(${o})`;
        }
        return typeof y == "function" ? qe._`${v}(${o})` : qe._`${v}.test(${o})`;
      }
    }
  } };
  tN.default = mQ;
});
var oN = k((nN) => {
  Object.defineProperty(nN, "__esModule", { value: true });
  var hQ = rN(), yQ = [hQ.default];
  nN.default = yQ;
});
var aN = k((iN) => {
  Object.defineProperty(iN, "__esModule", { value: true });
  iN.contentVocabulary = iN.metadataVocabulary = void 0;
  iN.metadataVocabulary = ["title", "description", "default", "deprecated", "readOnly", "writeOnly", "examples"];
  iN.contentVocabulary = ["contentMediaType", "contentEncoding", "contentSchema"];
});
var uN = k((lN) => {
  Object.defineProperty(lN, "__esModule", { value: true });
  var vQ = OM(), SQ = iD(), xQ = eN(), wQ = oN(), cN = aN(), kQ = [vQ.default, SQ.default, (0, xQ.default)(), wQ.default, cN.metadataVocabulary, cN.contentVocabulary];
  lN.default = kQ;
});
var mN = k((pN) => {
  Object.defineProperty(pN, "__esModule", { value: true });
  pN.DiscrError = void 0;
  var dN;
  (function(e) {
    e.Tag = "tag", e.Mapping = "mapping";
  })(dN || (pN.DiscrError = dN = {}));
});
var yN = k((hN) => {
  Object.defineProperty(hN, "__esModule", { value: true });
  var Rs = re(), gx = mN(), gN = Fm(), PQ = Vl(), TQ = ue(), IQ = { message: ({ params: { discrError: e, tagName: t } }) => e === gx.DiscrError.Tag ? `tag "${t}" must be string` : `value of tag "${t}" must be in oneOf`, params: ({ params: { discrError: e, tag: t, tagName: r } }) => Rs._`{error: ${e}, tag: ${r}, tagValue: ${t}}` }, RQ = { keyword: "discriminator", type: "object", schemaType: "object", error: IQ, code(e) {
    let { gen: t, data: r, schema: o, parentSchema: n, it: i } = e, { oneOf: s } = n;
    if (!i.opts.discriminator) throw Error("discriminator: requires discriminator option");
    let a = o.propertyName;
    if (typeof a != "string") throw Error("discriminator: requires propertyName");
    if (o.mapping) throw Error("discriminator: mapping is not supported");
    if (!s) throw Error("discriminator: requires oneOf keyword");
    let c = t.let("valid", false), u = t.const("tag", Rs._`${r}${(0, Rs.getProperty)(a)}`);
    t.if(Rs._`typeof ${u} == "string"`, () => d(), () => e.error(false, { discrError: gx.DiscrError.Tag, tag: u, tagName: a })), e.ok(c);
    function d() {
      let m = f();
      t.if(false);
      for (let g in m) t.elseIf(Rs._`${u} === ${g}`), t.assign(c, p(m[g]));
      t.else(), e.error(false, { discrError: gx.DiscrError.Mapping, tag: u, tagName: a }), t.endIf();
    }
    function p(m) {
      let g = t.name("valid"), h = e.subschema({ keyword: "oneOf", schemaProp: m }, g);
      return e.mergeEvaluated(h, Rs.Name), g;
    }
    function f() {
      var m;
      let g = {}, h = v(n), y = true;
      for (let $ = 0; $ < s.length; $++) {
        let U = s[$];
        if ((U === null || U === void 0 ? void 0 : U.$ref) && !(0, TQ.schemaHasRulesButRef)(U, i.self.RULES)) {
          let Le = U.$ref;
          if (U = gN.resolveRef.call(i.self, i.schemaEnv.root, i.baseId, Le), U instanceof gN.SchemaEnv) U = U.schema;
          if (U === void 0) throw new PQ.default(i.opts.uriResolver, i.baseId, Le);
        }
        let se = (m = U === null || U === void 0 ? void 0 : U.properties) === null || m === void 0 ? void 0 : m[a];
        if (typeof se != "object") throw Error(`discriminator: oneOf subschemas (or referenced schemas) must have "properties/${a}"`);
        y = y && (h || v(U)), w(se, $);
      }
      if (!y) throw Error(`discriminator: "${a}" must be required`);
      return g;
      function v({ required: $ }) {
        return Array.isArray($) && $.includes(a);
      }
      function w($, U) {
        if ($.const) x($.const, U);
        else if ($.enum) for (let se of $.enum) x(se, U);
        else throw Error(`discriminator: "properties/${a}" must have "const" or "enum"`);
      }
      function x($, U) {
        if (typeof $ != "string" || $ in g) throw Error(`discriminator: "${a}" values must be unique strings`);
        g[$] = U;
      }
    }
  } };
  hN.default = RQ;
});
var bN = k((zTe, AQ) => {
  AQ.exports = { $schema: "http://json-schema.org/draft-07/schema#", $id: "http://json-schema.org/draft-07/schema#", title: "Core schema meta-schema", definitions: { schemaArray: { type: "array", minItems: 1, items: { $ref: "#" } }, nonNegativeInteger: { type: "integer", minimum: 0 }, nonNegativeIntegerDefault0: { allOf: [{ $ref: "#/definitions/nonNegativeInteger" }, { default: 0 }] }, simpleTypes: { enum: ["array", "boolean", "integer", "null", "number", "object", "string"] }, stringArray: { type: "array", items: { type: "string" }, uniqueItems: true, default: [] } }, type: ["object", "boolean"], properties: { $id: { type: "string", format: "uri-reference" }, $schema: { type: "string", format: "uri" }, $ref: { type: "string", format: "uri-reference" }, $comment: { type: "string" }, title: { type: "string" }, description: { type: "string" }, default: true, readOnly: { type: "boolean", default: false }, examples: { type: "array", items: true }, multipleOf: { type: "number", exclusiveMinimum: 0 }, maximum: { type: "number" }, exclusiveMaximum: { type: "number" }, minimum: { type: "number" }, exclusiveMinimum: { type: "number" }, maxLength: { $ref: "#/definitions/nonNegativeInteger" }, minLength: { $ref: "#/definitions/nonNegativeIntegerDefault0" }, pattern: { type: "string", format: "regex" }, additionalItems: { $ref: "#" }, items: { anyOf: [{ $ref: "#" }, { $ref: "#/definitions/schemaArray" }], default: true }, maxItems: { $ref: "#/definitions/nonNegativeInteger" }, minItems: { $ref: "#/definitions/nonNegativeIntegerDefault0" }, uniqueItems: { type: "boolean", default: false }, contains: { $ref: "#" }, maxProperties: { $ref: "#/definitions/nonNegativeInteger" }, minProperties: { $ref: "#/definitions/nonNegativeIntegerDefault0" }, required: { $ref: "#/definitions/stringArray" }, additionalProperties: { $ref: "#" }, definitions: { type: "object", additionalProperties: { $ref: "#" }, default: {} }, properties: { type: "object", additionalProperties: { $ref: "#" }, default: {} }, patternProperties: { type: "object", additionalProperties: { $ref: "#" }, propertyNames: { format: "regex" }, default: {} }, dependencies: { type: "object", additionalProperties: { anyOf: [{ $ref: "#" }, { $ref: "#/definitions/stringArray" }] } }, propertyNames: { $ref: "#" }, const: true, enum: { type: "array", items: true, minItems: 1, uniqueItems: true }, type: { anyOf: [{ $ref: "#/definitions/simpleTypes" }, { type: "array", items: { $ref: "#/definitions/simpleTypes" }, minItems: 1, uniqueItems: true }] }, format: { type: "string" }, contentMediaType: { type: "string" }, contentEncoding: { type: "string" }, if: { $ref: "#" }, then: { $ref: "#" }, else: { $ref: "#" }, allOf: { $ref: "#/definitions/schemaArray" }, anyOf: { $ref: "#/definitions/schemaArray" }, oneOf: { $ref: "#/definitions/schemaArray" }, not: { $ref: "#" } }, default: true };
});
var yx = k(($t, hx) => {
  Object.defineProperty($t, "__esModule", { value: true });
  $t.MissingRefError = $t.ValidationError = $t.CodeGen = $t.Name = $t.nil = $t.stringify = $t.str = $t._ = $t.KeywordCxt = $t.Ajv = void 0;
  var OQ = xM(), CQ = uN(), MQ = yN(), _N = bN(), DQ = ["/properties"], ig = "http://json-schema.org/draft-07/schema";
  class nu extends OQ.default {
    _addVocabularies() {
      if (super._addVocabularies(), CQ.default.forEach((e) => this.addVocabulary(e)), this.opts.discriminator) this.addKeyword(MQ.default);
    }
    _addDefaultMetaSchema() {
      if (super._addDefaultMetaSchema(), !this.opts.meta) return;
      let e = this.opts.$data ? this.$dataMetaSchema(_N, DQ) : _N;
      this.addMetaSchema(e, ig, false), this.refs["http://json-schema.org/schema"] = ig;
    }
    defaultMeta() {
      return this.opts.defaultMeta = super.defaultMeta() || (this.getSchema(ig) ? ig : void 0);
    }
  }
  $t.Ajv = nu;
  hx.exports = $t = nu;
  hx.exports.Ajv = nu;
  Object.defineProperty($t, "__esModule", { value: true });
  $t.default = nu;
  var NQ = ql();
  Object.defineProperty($t, "KeywordCxt", { enumerable: true, get: function() {
    return NQ.KeywordCxt;
  } });
  var $s = re();
  Object.defineProperty($t, "_", { enumerable: true, get: function() {
    return $s._;
  } });
  Object.defineProperty($t, "str", { enumerable: true, get: function() {
    return $s.str;
  } });
  Object.defineProperty($t, "stringify", { enumerable: true, get: function() {
    return $s.stringify;
  } });
  Object.defineProperty($t, "nil", { enumerable: true, get: function() {
    return $s.nil;
  } });
  Object.defineProperty($t, "Name", { enumerable: true, get: function() {
    return $s.Name;
  } });
  Object.defineProperty($t, "CodeGen", { enumerable: true, get: function() {
    return $s.CodeGen;
  } });
  var jQ = zm();
  Object.defineProperty($t, "ValidationError", { enumerable: true, get: function() {
    return jQ.default;
  } });
  var UQ = Vl();
  Object.defineProperty($t, "MissingRefError", { enumerable: true, get: function() {
    return UQ.default;
  } });
});
var RN = k((TN) => {
  Object.defineProperty(TN, "__esModule", { value: true });
  TN.formatNames = TN.fastFormats = TN.fullFormats = void 0;
  function $r(e, t) {
    return { validate: e, compare: t };
  }
  TN.fullFormats = { date: $r(wN, Sx), time: $r(_x(true), xx), "date-time": $r(vN(true), EN), "iso-time": $r(_x(), kN), "iso-date-time": $r(vN(), PN), duration: /^P(?!$)((\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?|(\d+W)?)$/, uri: ZQ, "uri-reference": /^(?:[a-z][a-z0-9+\-.]*:)?(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'"()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*)?(?:\?(?:[a-z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i, "uri-template": /^(?:(?:[^\x00-\x20"'<>%\\^`{|}]|%[0-9a-f]{2})|\{[+#./;?&=,!@|]?(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?(?:,(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?)*\})*$/i, url: /^(?:https?|ftp):\/\/(?:\S+(?::\S*)?@)?(?:(?!(?:10|127)(?:\.\d{1,3}){3})(?!(?:169\.254|192\.168)(?:\.\d{1,3}){2})(?!172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){2}(?:\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4]))|(?:(?:[a-z0-9\u{00a1}-\u{ffff}]+-)*[a-z0-9\u{00a1}-\u{ffff}]+)(?:\.(?:[a-z0-9\u{00a1}-\u{ffff}]+-)*[a-z0-9\u{00a1}-\u{ffff}]+)*(?:\.(?:[a-z\u{00a1}-\u{ffff}]{2,})))(?::\d{2,5})?(?:\/[^\s]*)?$/iu, email: /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i, hostname: /^(?=.{1,253}\.?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-0-9a-z]{0,61}[0-9a-z])?)*\.?$/i, ipv4: /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/, ipv6: /^((([0-9a-f]{1,4}:){7}([0-9a-f]{1,4}|:))|(([0-9a-f]{1,4}:){6}(:[0-9a-f]{1,4}|((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){5}(((:[0-9a-f]{1,4}){1,2})|:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){4}(((:[0-9a-f]{1,4}){1,3})|((:[0-9a-f]{1,4})?:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){3}(((:[0-9a-f]{1,4}){1,4})|((:[0-9a-f]{1,4}){0,2}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){2}(((:[0-9a-f]{1,4}){1,5})|((:[0-9a-f]{1,4}){0,3}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){1}(((:[0-9a-f]{1,4}){1,6})|((:[0-9a-f]{1,4}){0,4}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(:(((:[0-9a-f]{1,4}){1,7})|((:[0-9a-f]{1,4}){0,5}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:)))$/i, regex: QQ, uuid: /^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i, "json-pointer": /^(?:\/(?:[^~/]|~0|~1)*)*$/, "json-pointer-uri-fragment": /^#(?:\/(?:[a-z0-9_\-.!$&'()*+,;:=@]|%[0-9a-f]{2}|~0|~1)*)*$/i, "relative-json-pointer": /^(?:0|[1-9][0-9]*)(?:#|(?:\/(?:[^~/]|~0|~1)*)*)$/, byte: WQ, int32: { type: "number", validate: JQ }, int64: { type: "number", validate: XQ }, float: { type: "number", validate: xN }, double: { type: "number", validate: xN }, password: true, binary: true };
  TN.fastFormats = { ...TN.fullFormats, date: $r(/^\d\d\d\d-[0-1]\d-[0-3]\d$/, Sx), time: $r(/^(?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)$/i, xx), "date-time": $r(/^\d\d\d\d-[0-1]\d-[0-3]\dt(?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)$/i, EN), "iso-time": $r(/^(?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)?$/i, kN), "iso-date-time": $r(/^\d\d\d\d-[0-1]\d-[0-3]\d[t\s](?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)?$/i, PN), uri: /^(?:[a-z][a-z0-9+\-.]*:)(?:\/?\/)?[^\s]*$/i, "uri-reference": /^(?:(?:[a-z][a-z0-9+\-.]*:)?\/?\/)?(?:[^\\\s#][^\s#]*)?(?:#[^\\\s]*)?$/i, email: /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i };
  TN.formatNames = Object.keys(TN.fullFormats);
  function FQ(e) {
    return e % 4 === 0 && (e % 100 !== 0 || e % 400 === 0);
  }
  var HQ = /^(\d\d\d\d)-(\d\d)-(\d\d)$/, BQ = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  function wN(e) {
    let t = HQ.exec(e);
    if (!t) return false;
    let r = +t[1], o = +t[2], n = +t[3];
    return o >= 1 && o <= 12 && n >= 1 && n <= (o === 2 && FQ(r) ? 29 : BQ[o]);
  }
  function Sx(e, t) {
    if (!(e && t)) return;
    if (e > t) return 1;
    if (e < t) return -1;
    return 0;
  }
  var bx = /^(\d\d):(\d\d):(\d\d(?:\.\d+)?)(z|([+-])(\d\d)(?::?(\d\d))?)?$/i;
  function _x(e) {
    return function(r) {
      let o = bx.exec(r);
      if (!o) return false;
      let n = +o[1], i = +o[2], s = +o[3], a = o[4], c = o[5] === "-" ? -1 : 1, u = +(o[6] || 0), d = +(o[7] || 0);
      if (u > 23 || d > 59 || e && !a) return false;
      if (n <= 23 && i <= 59 && s < 60) return true;
      let p = i - d * c, f = n - u * c - (p < 0 ? 1 : 0);
      return (f === 23 || f === -1) && (p === 59 || p === -1) && s < 61;
    };
  }
  function xx(e, t) {
    if (!(e && t)) return;
    let r = (/* @__PURE__ */ new Date("2020-01-01T" + e)).valueOf(), o = (/* @__PURE__ */ new Date("2020-01-01T" + t)).valueOf();
    if (!(r && o)) return;
    return r - o;
  }
  function kN(e, t) {
    if (!(e && t)) return;
    let r = bx.exec(e), o = bx.exec(t);
    if (!(r && o)) return;
    if (e = r[1] + r[2] + r[3], t = o[1] + o[2] + o[3], e > t) return 1;
    if (e < t) return -1;
    return 0;
  }
  var vx = /t|\s/i;
  function vN(e) {
    let t = _x(e);
    return function(o) {
      let n = o.split(vx);
      return n.length === 2 && wN(n[0]) && t(n[1]);
    };
  }
  function EN(e, t) {
    if (!(e && t)) return;
    let r = new Date(e).valueOf(), o = new Date(t).valueOf();
    if (!(r && o)) return;
    return r - o;
  }
  function PN(e, t) {
    if (!(e && t)) return;
    let [r, o] = e.split(vx), [n, i] = t.split(vx), s = Sx(r, n);
    if (s === void 0) return;
    return s || xx(o, i);
  }
  var qQ = /\/|:/, VQ = /^(?:[a-z][a-z0-9+\-.]*:)(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)(?:\?(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i;
  function ZQ(e) {
    return qQ.test(e) && VQ.test(e);
  }
  var SN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/gm;
  function WQ(e) {
    return SN.lastIndex = 0, SN.test(e);
  }
  var KQ = -2147483648, GQ = 2147483647;
  function JQ(e) {
    return Number.isInteger(e) && e <= GQ && e >= KQ;
  }
  function XQ(e) {
    return Number.isInteger(e);
  }
  function xN() {
    return true;
  }
  var YQ = /[^\\]\\Z/;
  function QQ(e) {
    if (YQ.test(e)) return false;
    try {
      return new RegExp(e), true;
    } catch (t) {
      return false;
    }
  }
});
var AN = k(($N) => {
  Object.defineProperty($N, "__esModule", { value: true });
  $N.formatLimitDefinition = void 0;
  var tee = yx(), vr = re(), Zn = vr.operators, sg = { formatMaximum: { okStr: "<=", ok: Zn.LTE, fail: Zn.GT }, formatMinimum: { okStr: ">=", ok: Zn.GTE, fail: Zn.LT }, formatExclusiveMaximum: { okStr: "<", ok: Zn.LT, fail: Zn.GTE }, formatExclusiveMinimum: { okStr: ">", ok: Zn.GT, fail: Zn.LTE } }, ree = { message: ({ keyword: e, schemaCode: t }) => vr.str`should be ${sg[e].okStr} ${t}`, params: ({ keyword: e, schemaCode: t }) => vr._`{comparison: ${sg[e].okStr}, limit: ${t}}` };
  $N.formatLimitDefinition = { keyword: Object.keys(sg), type: "string", schemaType: "string", $data: true, error: ree, code(e) {
    let { gen: t, data: r, schemaCode: o, keyword: n, it: i } = e, { opts: s, self: a } = i;
    if (!s.validateFormats) return;
    let c = new tee.KeywordCxt(i, a.RULES.all.format.definition, "format");
    if (c.$data) u();
    else d();
    function u() {
      let f = t.scopeValue("formats", { ref: a.formats, code: s.code.formats }), m = t.const("fmt", vr._`${f}[${c.schemaCode}]`);
      e.fail$data((0, vr.or)(vr._`typeof ${m} != "object"`, vr._`${m} instanceof RegExp`, vr._`typeof ${m}.compare != "function"`, p(m)));
    }
    function d() {
      let f = c.schema, m = a.formats[f];
      if (!m || m === true) return;
      if (typeof m != "object" || m instanceof RegExp || typeof m.compare != "function") throw Error(`"${n}": format "${f}" does not define "compare" function`);
      let g = t.scopeValue("formats", { key: f, ref: m, code: s.code.formats ? vr._`${s.code.formats}${(0, vr.getProperty)(f)}` : void 0 });
      e.fail$data(p(g));
    }
    function p(f) {
      return vr._`${f}.compare(${r}, ${o}) ${sg[n].fail} 0`;
    }
  }, dependencies: ["format"] };
  var nee = (e) => (e.addKeyword($N.formatLimitDefinition), e);
  $N.default = nee;
});
var DN = k((ou, MN) => {
  Object.defineProperty(ou, "__esModule", { value: true });
  var As = RN(), iee = AN(), Ex = re(), ON = new Ex.Name("fullFormats"), see = new Ex.Name("fastFormats"), Px = (e, t = { keywords: true }) => {
    if (Array.isArray(t)) return CN(e, t, As.fullFormats, ON), e;
    let [r, o] = t.mode === "fast" ? [As.fastFormats, see] : [As.fullFormats, ON], n = t.formats || As.formatNames;
    if (CN(e, n, r, o), t.keywords) (0, iee.default)(e);
    return e;
  };
  Px.get = (e, t = "full") => {
    let o = (t === "fast" ? As.fastFormats : As.fullFormats)[e];
    if (!o) throw Error(`Unknown format "${e}"`);
    return o;
  };
  function CN(e, t, r, o) {
    var n, i;
    (n = (i = e.opts.code).formats) !== null && n !== void 0 || (i.formats = Ex._`require("ajv-formats/dist/formats").${o}`);
    for (let s of t) e.addFormat(s, r[s]);
  }
  MN.exports = ou = Px;
  Object.defineProperty(ou, "__esModule", { value: true });
  ou.default = Px;
});
var Qz = 50;
function Ks(e = Qz) {
  let t = new AbortController();
  return Yz(e, t.signal), t;
}
var Xne = new FinalizationRegistry(({ parentSignalRef: e, handler: t }) => {
  e.deref()?.removeEventListener("abort", t);
});
function Cr(e) {
  return process.platform === "darwin" ? e.normalize("NFC") : e;
}
function Gs(e) {
  return /^[\\/]{2}/.test(e);
}
function Xs(e) {
  return /^[\\/]{2}wsl(\$|\.localhost)[\\/]/i.test(e);
}
function Rw(e) {
  if (e.startsWith("\\\\?\\UNC\\")) return "\\\\" + e.slice(8);
  if (e.startsWith("\\\\?\\") && e.length >= 7 && e[5] === ":") return e.slice(4);
  return e;
}
function $w(e) {
  if (/^\\\\\?\\volume\{/i.test(e)) return Tw(e);
  let t = Rw(e);
  if (t !== e && Tw(t)) return true;
  return Gs(t) && !Xs(t);
}
function Tw(e) {
  return /(^|[\\/])\.{1,2}([\\/]|$)/.test(e) || e.includes("/");
}
function un(e, t, r) {
  return new Promise((o, n) => {
    if (t?.aborted) {
      if (r?.throwOnAbort || r?.abortError) n(r.abortError?.() ?? Error("aborted"));
      else o();
      return;
    }
    let i = setTimeout((a, c, u) => {
      a?.removeEventListener("abort", c), u();
    }, e, t, s, o);
    function s() {
      if (clearTimeout(i), r?.throwOnAbort || r?.abortError) n(r.abortError?.() ?? Error("aborted"));
      else o();
    }
    if (t?.addEventListener("abort", s, { once: true }), r?.unref) i.unref();
  });
}
function tL(e, t) {
  e(Error(t));
}
function Mr(e, t, r) {
  let o, n = new Promise((i, s) => {
    o = setTimeout(tL, t, s, r);
  });
  return Promise.race([e, n]).finally(() => {
    if (o !== void 0) clearTimeout(o);
  });
}
var ei = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch", "Notification", "UserPromptSubmit", "UserPromptExpansion", "SessionStart", "SessionEnd", "Stop", "StopFailure", "SubagentStart", "SubagentStop", "PreCompact", "PostCompact", "PermissionRequest", "PermissionDenied", "Setup", "TeammateIdle", "TaskCreated", "TaskCompleted", "Elicitation", "ElicitationResult", "ConfigChange", "WorktreeCreate", "WorktreeRemove", "InstructionsLoaded", "CwdChanged", "FileChanged", "MessageDisplay"];
var ot = class extends Error {
};
function ku() {
  return process.versions.bun !== void 0;
}
var Cw = globalThis.process?.getBuiltinModule?.("async_hooks");
var Dg = Cw ? (e) => Cw.AsyncResource.bind(e) : (e) => e;
function Ee(e) {
  if (!e) return false;
  if (typeof e === "boolean") return e;
  let t = String(e).toLowerCase().trim();
  return ["1", "true", "yes", "on"].includes(t);
}
function pn() {
  let e = /* @__PURE__ */ new Set();
  return { subscribe(t) {
    let r = Dg(t);
    return e.add(r), () => {
      e.delete(r);
    };
  }, emit(...t) {
    let r;
    for (let o of e) try {
      o(...t);
    } catch (n) {
      (r ??= []).push(n);
    }
    if (r) throw r.length === 1 ? r[0] : AggregateError(r, "Signal listener(s) threw");
  }, clear() {
    e.clear();
  } };
}
var dL = typeof global == "object" && global && global.Object === Object && global;
var Eu = dL;
var pL = typeof self == "object" && self && self.Object === Object && self;
var fL = Eu || pL || Function("return this")();
var Bt = fL;
var mL = Bt.Symbol;
var qt = mL;
var Mw = Object.prototype;
var gL = Mw.hasOwnProperty;
var hL = Mw.toString;
var Qs = qt ? qt.toStringTag : void 0;
function yL(e) {
  var t = gL.call(e, Qs), r = e[Qs];
  try {
    e[Qs] = void 0;
    var o = true;
  } catch (i) {
  }
  var n = hL.call(e);
  if (o) if (t) e[Qs] = r;
  else delete e[Qs];
  return n;
}
var Dw = yL;
var bL = Object.prototype;
var _L = bL.toString;
function vL(e) {
  return _L.call(e);
}
var Nw = vL;
var SL = "[object Null]";
var xL = "[object Undefined]";
var jw = qt ? qt.toStringTag : void 0;
function wL(e) {
  if (e == null) return e === void 0 ? xL : SL;
  return jw && jw in Object(e) ? Dw(e) : Nw(e);
}
var Er = wL;
function kL(e) {
  var t = typeof e;
  return e != null && (t == "object" || t == "function");
}
var Qe = kL;
var EL = "[object AsyncFunction]";
var PL = "[object Function]";
var TL = "[object GeneratorFunction]";
var IL = "[object Proxy]";
function RL(e) {
  if (!Qe(e)) return false;
  var t = Er(e);
  return t == PL || t == TL || t == EL || t == IL;
}
var ti = RL;
var $L = Bt["__core-js_shared__"];
var Pu = $L;
var Uw = (function() {
  var e = /[^.]+$/.exec(Pu && Pu.keys && Pu.keys.IE_PROTO || "");
  return e ? "Symbol(src)_1." + e : "";
})();
function AL(e) {
  return !!Uw && Uw in e;
}
var zw = AL;
var OL = Function.prototype;
var CL = OL.toString;
function ML(e) {
  if (e != null) {
    try {
      return CL.call(e);
    } catch (t) {
    }
    try {
      return e + "";
    } catch (t) {
    }
  }
  return "";
}
var Lw = ML;
var DL = /[\\^$.*+?()[\]{}|]/g;
var NL = /^\[object .+?Constructor\]$/;
var jL = Function.prototype;
var UL = Object.prototype;
var zL = jL.toString;
var LL = UL.hasOwnProperty;
var FL = RegExp("^" + zL.call(LL).replace(DL, "\\$&").replace(/hasOwnProperty|(function).*?(?=\\\()| for .+?(?=\\\])/g, "$1.*?") + "$");
function HL(e) {
  if (!Qe(e) || zw(e)) return false;
  var t = ti(e) ? FL : NL;
  return t.test(Lw(e));
}
var Fw = HL;
function BL(e, t) {
  return e == null ? void 0 : e[t];
}
var Hw = BL;
function qL(e, t) {
  var r = Hw(e, t);
  return Fw(r) ? r : void 0;
}
var ri = qL;
var VL = ri(Object, "create");
var Dr = VL;
function ZL() {
  this.__data__ = Dr ? Dr(null) : {}, this.size = 0;
}
var Bw = ZL;
function WL(e) {
  var t = this.has(e) && delete this.__data__[e];
  return this.size -= t ? 1 : 0, t;
}
var qw = WL;
var KL = "__lodash_hash_undefined__";
var GL = Object.prototype;
var JL = GL.hasOwnProperty;
function XL(e) {
  var t = this.__data__;
  if (Dr) {
    var r = t[e];
    return r === KL ? void 0 : r;
  }
  return JL.call(t, e) ? t[e] : void 0;
}
var Vw = XL;
var YL = Object.prototype;
var QL = YL.hasOwnProperty;
function e1(e) {
  var t = this.__data__;
  return Dr ? t[e] !== void 0 : QL.call(t, e);
}
var Zw = e1;
var t1 = "__lodash_hash_undefined__";
function r1(e, t) {
  var r = this.__data__;
  return this.size += this.has(e) ? 0 : 1, r[e] = Dr && t === void 0 ? t1 : t, this;
}
var Ww = r1;
function ni(e) {
  var t = -1, r = e == null ? 0 : e.length;
  this.clear();
  while (++t < r) {
    var o = e[t];
    this.set(o[0], o[1]);
  }
}
ni.prototype.clear = Bw;
ni.prototype.delete = qw;
ni.prototype.get = Vw;
ni.prototype.has = Zw;
ni.prototype.set = Ww;
var Ng = ni;
function n1() {
  this.__data__ = [], this.size = 0;
}
var Kw = n1;
function o1(e, t) {
  return e === t || e !== e && t !== t;
}
var fn = o1;
function i1(e, t) {
  var r = e.length;
  while (r--) if (fn(e[r][0], t)) return r;
  return -1;
}
var mn = i1;
var s1 = Array.prototype;
var a1 = s1.splice;
function c1(e) {
  var t = this.__data__, r = mn(t, e);
  if (r < 0) return false;
  var o = t.length - 1;
  if (r == o) t.pop();
  else a1.call(t, r, 1);
  return --this.size, true;
}
var Gw = c1;
function l1(e) {
  var t = this.__data__, r = mn(t, e);
  return r < 0 ? void 0 : t[r][1];
}
var Jw = l1;
function u1(e) {
  return mn(this.__data__, e) > -1;
}
var Xw = u1;
function d1(e, t) {
  var r = this.__data__, o = mn(r, e);
  if (o < 0) ++this.size, r.push([e, t]);
  else r[o][1] = t;
  return this;
}
var Yw = d1;
function oi(e) {
  var t = -1, r = e == null ? 0 : e.length;
  this.clear();
  while (++t < r) {
    var o = e[t];
    this.set(o[0], o[1]);
  }
}
oi.prototype.clear = Kw;
oi.prototype.delete = Gw;
oi.prototype.get = Jw;
oi.prototype.has = Xw;
oi.prototype.set = Yw;
var gn = oi;
var p1 = ri(Bt, "Map");
var Tu = p1;
function f1() {
  this.size = 0, this.__data__ = { hash: new Ng(), map: new (Tu || gn)(), string: new Ng() };
}
var Qw = f1;
function m1(e) {
  var t = typeof e;
  return t == "string" || t == "number" || t == "symbol" || t == "boolean" ? e !== "__proto__" : e === null;
}
var ek = m1;
function g1(e, t) {
  var r = e.__data__;
  return ek(t) ? r[typeof t == "string" ? "string" : "hash"] : r.map;
}
var hn = g1;
function h1(e) {
  var t = hn(this, e).delete(e);
  return this.size -= t ? 1 : 0, t;
}
var tk = h1;
function y1(e) {
  return hn(this, e).get(e);
}
var rk = y1;
function b1(e) {
  return hn(this, e).has(e);
}
var nk = b1;
function _1(e, t) {
  var r = hn(this, e), o = r.size;
  return r.set(e, t), this.size += r.size == o ? 0 : 1, this;
}
var ok = _1;
function ii(e) {
  var t = -1, r = e == null ? 0 : e.length;
  this.clear();
  while (++t < r) {
    var o = e[t];
    this.set(o[0], o[1]);
  }
}
ii.prototype.clear = Qw;
ii.prototype.delete = tk;
ii.prototype.get = rk;
ii.prototype.has = nk;
ii.prototype.set = ok;
var ea = ii;
var v1 = "Expected a function";
function jg(e, t) {
  if (typeof e != "function" || t != null && typeof t != "function") throw TypeError(v1);
  var r = function() {
    var o = arguments, n = t ? t.apply(this, o) : o[0], i = r.cache;
    if (i.has(n)) return i.get(n);
    var s = e.apply(this, o);
    return r.cache = i.set(n, s) || i, s;
  };
  return r.cache = new (jg.Cache || ea)(), r;
}
jg.Cache = ea;
var Ce = jg;
var Vt = Ce(() => (process.env.CLAUDE_CONFIG_DIR ?? x1(S1(), ".claude")).normalize("NFC"), () => process.env.CLAUDE_CONFIG_DIR);
var _se = Ce(() => Ee(process.env.CLAUDE_CODE_SUPERVISED));
function N(e, t, r, o, n) {
  if (o === "m") throw TypeError("Private method is not writable");
  if (o === "a" && !n) throw TypeError("Private accessor was defined without a setter");
  if (typeof t === "function" ? e !== t || !n : !t.has(e)) throw TypeError("Cannot write private member to an object whose class did not declare it");
  return o === "a" ? n.call(e, r) : n ? n.value = r : t.set(e, r), r;
}
function _(e, t, r, o) {
  if (r === "a" && !o) throw TypeError("Private accessor was defined without a getter");
  if (typeof t === "function" ? e !== t || !o : !t.has(e)) throw TypeError("Cannot read private member from an object whose class did not declare it");
  return r === "m" ? o : r === "a" ? o.call(e) : o ? o.value : t.get(e);
}
var Ug = function() {
  let { crypto: e } = globalThis;
  if (e?.randomUUID) return Ug = e.randomUUID.bind(e), e.randomUUID();
  let t = new Uint8Array(1), r = e ? () => e.getRandomValues(t)[0] : () => Math.random() * 255 & 255;
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (o) => (+o ^ r() & 15 >> +o / 4).toString(16));
};
function Nr(e) {
  return typeof e === "object" && e !== null && ("name" in e && e.name === "AbortError" || "message" in e && String(e.message).includes("FetchRequestCanceledException"));
}
var ta = (e) => {
  if (e instanceof Error) return e;
  if (typeof e === "object" && e !== null) {
    try {
      if (Object.prototype.toString.call(e) === "[object Error]") {
        let t = Error(e.message, e.cause ? { cause: e.cause } : {});
        if (e.stack) t.stack = e.stack;
        if (e.cause && !t.cause) t.cause = e.cause;
        if (e.name) t.name = e.name;
        return t;
      }
    } catch {
    }
    try {
      return Error(JSON.stringify(e));
    } catch {
    }
  }
  return Error(e);
};
var z = class extends Error {
};
var Ke = class _Ke extends z {
  constructor(e, t, r, o, n) {
    super(`${_Ke.makeMessage(e, t, r)}`);
    this.status = e, this.headers = o, this.requestID = o?.get("request-id"), this.error = t, this.type = n ?? null;
  }
  static makeMessage(e, t, r) {
    let o = t?.message ? typeof t.message === "string" ? t.message : JSON.stringify(t.message) : t ? JSON.stringify(t) : r;
    if (e && o) return `${e} ${o}`;
    if (e) return `${e} status code (no body)`;
    if (o) return o;
    return "(no status code or body)";
  }
  static generate(e, t, r, o) {
    if (!e || !o) return new no({ message: r, cause: ta(t) });
    let n = t, i = n?.error?.type;
    if (e === 400) return new na(e, n, r, o, i);
    if (e === 401) return new oa(e, n, r, o, i);
    if (e === 403) return new ia(e, n, r, o, i);
    if (e === 404) return new sa(e, n, r, o, i);
    if (e === 409) return new aa(e, n, r, o, i);
    if (e === 422) return new ca(e, n, r, o, i);
    if (e === 429) return new la(e, n, r, o, i);
    if (e >= 500) return new ua(e, n, r, o, i);
    return new _Ke(e, n, r, o, i);
  }
};
var et = class extends Ke {
  constructor({ message: e } = {}) {
    super(void 0, void 0, e || "Request was aborted.", void 0);
  }
};
var no = class extends Ke {
  constructor({ message: e, cause: t }) {
    super(void 0, void 0, e || "Connection error.", void 0);
    if (t) this.cause = t;
  }
};
var ra = class extends no {
  constructor({ message: e } = {}) {
    super({ message: e ?? "Request timed out." });
  }
};
var na = class extends Ke {
};
var oa = class extends Ke {
};
var ia = class extends Ke {
};
var sa = class extends Ke {
};
var aa = class extends Ke {
};
var ca = class extends Ke {
};
var la = class extends Ke {
};
var ua = class extends Ke {
};
var k1 = /^[a-z][a-z0-9+.-]*:/i;
var ik = (e) => k1.test(e);
var zg = (e) => (zg = Array.isArray, zg(e));
var Lg = zg;
function Iu(e) {
  if (typeof e !== "object") return {};
  return e ?? {};
}
function Fg(e) {
  if (!e) return true;
  for (let t in e) return false;
  return true;
}
function sk(e, t) {
  return Object.prototype.hasOwnProperty.call(e, t);
}
var ak = (e, t) => {
  if (typeof t !== "number" || !Number.isInteger(t)) throw new z(`${e} must be an integer`);
  if (t < 0) throw new z(`${e} must be a positive integer`);
  return t;
};
var Ru = (e) => {
  try {
    return JSON.parse(e);
  } catch (t) {
    return;
  }
};
var ck = (e) => new Promise((t) => setTimeout(t, e));
var Zt = "0.94.0";
var pk = () => typeof window < "u" && typeof window.document < "u" && typeof navigator < "u";
function E1() {
  if (typeof Deno < "u" && Deno.build != null) return "deno";
  if (typeof EdgeRuntime < "u") return "edge";
  if (Object.prototype.toString.call(typeof globalThis.process < "u" ? globalThis.process : 0) === "[object process]") return "node";
  return "unknown";
}
var P1 = () => {
  let e = E1();
  if (e === "deno") return { "X-Stainless-Lang": "js", "X-Stainless-Package-Version": Zt, "X-Stainless-OS": uk(Deno.build.os), "X-Stainless-Arch": lk(Deno.build.arch), "X-Stainless-Runtime": "deno", "X-Stainless-Runtime-Version": typeof Deno.version === "string" ? Deno.version : Deno.version?.deno ?? "unknown" };
  if (typeof EdgeRuntime < "u") return { "X-Stainless-Lang": "js", "X-Stainless-Package-Version": Zt, "X-Stainless-OS": "Unknown", "X-Stainless-Arch": `other:${EdgeRuntime}`, "X-Stainless-Runtime": "edge", "X-Stainless-Runtime-Version": globalThis.process.version };
  if (e === "node") return { "X-Stainless-Lang": "js", "X-Stainless-Package-Version": Zt, "X-Stainless-OS": uk(globalThis.process.platform ?? "unknown"), "X-Stainless-Arch": lk(globalThis.process.arch ?? "unknown"), "X-Stainless-Runtime": "node", "X-Stainless-Runtime-Version": globalThis.process.version ?? "unknown" };
  let t = T1();
  if (t) return { "X-Stainless-Lang": "js", "X-Stainless-Package-Version": Zt, "X-Stainless-OS": "Unknown", "X-Stainless-Arch": "unknown", "X-Stainless-Runtime": `browser:${t.browser}`, "X-Stainless-Runtime-Version": t.version };
  return { "X-Stainless-Lang": "js", "X-Stainless-Package-Version": Zt, "X-Stainless-OS": "Unknown", "X-Stainless-Arch": "unknown", "X-Stainless-Runtime": "unknown", "X-Stainless-Runtime-Version": "unknown" };
};
function T1() {
  if (typeof navigator > "u" || !navigator) return null;
  let e = [{ key: "edge", pattern: /Edge(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/ }, { key: "ie", pattern: /MSIE(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/ }, { key: "ie", pattern: /Trident(?:.*rv\:(\d+)\.(\d+)(?:\.(\d+))?)?/ }, { key: "chrome", pattern: /Chrome(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/ }, { key: "firefox", pattern: /Firefox(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/ }, { key: "safari", pattern: /(?:Version\W+(\d+)\.(\d+)(?:\.(\d+))?)?(?:\W+Mobile\S*)?\W+Safari/ }];
  for (let { key: t, pattern: r } of e) {
    let o = r.exec(navigator.userAgent);
    if (o) {
      let n = o[1] || 0, i = o[2] || 0, s = o[3] || 0;
      return { browser: t, version: `${n}.${i}.${s}` };
    }
  }
  return null;
}
var lk = (e) => {
  if (e === "x32") return "x32";
  if (e === "x86_64" || e === "x64") return "x64";
  if (e === "arm") return "arm";
  if (e === "aarch64" || e === "arm64") return "arm64";
  if (e) return `other:${e}`;
  return "unknown";
};
var uk = (e) => {
  if (e = e.toLowerCase(), e.includes("ios")) return "iOS";
  if (e === "android") return "Android";
  if (e === "darwin") return "MacOS";
  if (e === "win32") return "Windows";
  if (e === "freebsd") return "FreeBSD";
  if (e === "openbsd") return "OpenBSD";
  if (e === "linux") return "Linux";
  if (e) return `Other:${e}`;
  return "Unknown";
};
var dk;
var da = () => dk ?? (dk = P1());
function fk() {
  if (typeof fetch < "u") return fetch;
  throw Error("`fetch` is not defined as a global; Either pass `fetch` to the client, `new Anthropic({ fetch })` or polyfill the global, `globalThis.fetch = fetch`");
}
function Hg(...e) {
  let t = globalThis.ReadableStream;
  if (typeof t > "u") throw Error("`ReadableStream` is not defined as a global; You will need to polyfill it, `globalThis.ReadableStream = ReadableStream`");
  return new t(...e);
}
function $u(e) {
  let t = Symbol.asyncIterator in e ? e[Symbol.asyncIterator]() : e[Symbol.iterator]();
  return Hg({ start() {
  }, async pull(r) {
    let { done: o, value: n } = await t.next();
    if (o) r.close();
    else r.enqueue(n);
  }, async cancel() {
    await t.return?.();
  } });
}
function pa(e) {
  if (e[Symbol.asyncIterator]) return e;
  let t = e.getReader();
  return { async next() {
    try {
      let r = await t.read();
      if (r?.done) t.releaseLock();
      return r;
    } catch (r) {
      throw t.releaseLock(), r;
    }
  }, async return() {
    let r = t.cancel();
    return t.releaseLock(), await r, { done: true, value: void 0 };
  }, [Symbol.asyncIterator]() {
    return this;
  } };
}
async function mk(e) {
  if (e === null || typeof e !== "object") return;
  if (e[Symbol.asyncIterator]) {
    await e[Symbol.asyncIterator]().return?.();
    return;
  }
  let t = e.getReader(), r = t.cancel();
  t.releaseLock(), await r;
}
var gk = ({ headers: e, body: t }) => ({ bodyHeaders: { "content-type": "application/json" }, body: JSON.stringify(t) });
function hk(e) {
  return Object.entries(e).filter(([t, r]) => typeof r < "u").map(([t, r]) => {
    if (typeof r === "string" || typeof r === "number" || typeof r === "boolean") return `${encodeURIComponent(t)}=${encodeURIComponent(r)}`;
    if (r === null) return `${encodeURIComponent(t)}=`;
    throw new z(`Cannot stringify type ${typeof r}; Expected string, number, boolean, or null. If you need to pass nested query parameters, you can manually encode them, e.g. { query: { 'foo[key1]': value1, 'foo[key2]': value2 } }, and please open a GitHub issue requesting better support for your use case.`);
  }).join("&");
}
var bk = "urn:ietf:params:oauth:grant-type:jwt-bearer";
var _k = "refresh_token";
var Au = "/v1/oauth/token";
var oo = "oauth-2025-04-20";
var vk = "oidc-federation-2026-04-01";
var Sk = 120;
var si = 30;
var xk = 5;
var yk = 1048576;
function Ou(e) {
  if (!e) return;
  let t;
  try {
    t = new URL(e);
  } catch (o) {
    throw new he(`Invalid token endpoint base URL "${e}": ${o}`);
  }
  if (t.protocol === "https:") return;
  let r = t.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (t.protocol === "http:" && (r === "localhost" || r === "127.0.0.1" || r === "::1")) return;
  throw new he(`Refusing to send credential over non-https token endpoint "${e}"`);
}
async function Cu(e, t) {
  let r = await A1(e), o;
  try {
    o = JSON.parse(r);
  } catch {
    throw new he(`Token endpoint returned non-JSON response (status ${e.status})`, e.status, vt(r), t);
  }
  if (!o.access_token) throw new he(`Token endpoint response missing access_token: ${JSON.stringify(vt(o))}`, e.status, vt(o), t);
  if (o.token_type && o.token_type.toLowerCase() !== "bearer") throw new he(`Token endpoint response: unsupported token_type "${o.token_type}" (want Bearer)`, e.status, vt(o), t);
  return o;
}
var Bg = 2e3;
var $1 = /* @__PURE__ */ new Set(["error", "error_description", "error_uri"]);
function vt(e) {
  if (e == null) return e;
  if (typeof e === "string") {
    let t;
    try {
      t = JSON.parse(e);
    } catch {
      if (e.length <= Bg) return e;
      return e.slice(0, Bg) + `... <${e.length - Bg} more chars>`;
    }
    return JSON.stringify(vt(t));
  }
  if (typeof e === "object" && !Array.isArray(e)) {
    let t = {};
    for (let [r, o] of Object.entries(e)) if ($1.has(r)) t[r] = o;
    return t;
  }
  return null;
}
async function Mu(e, t = (r) => console.warn(`anthropic-sdk: ${r}`)) {
  if (typeof process > "u" || process.platform === "win32") return;
  let r = await import("node:fs"), o = e, n;
  try {
    o = await r.promises.realpath(e), n = await r.promises.stat(o);
  } catch {
    return;
  }
  let i = n.mode & 511;
  if (i & 18) throw new he(`Credentials file at ${o} is group/world-writable (mode 0o${i.toString(8)}); this allows other local users to plant tokens. Run \`chmod 600 ${o}\`.`);
  if (i & 36) throw new he(`Credentials file at ${o} is group/world-readable (mode 0o${i.toString(8)}); run \`chmod 600 ${o}\` before retrying.`);
  if (typeof process.getuid === "function" && n.uid !== process.getuid()) t(`credentials file at ${o} is owned by uid ${n.uid} (current process uid ${process.getuid()}); verify this is intentional.`);
}
async function Du(e, t) {
  let r = await import("node:fs"), n = (await import("node:path")).dirname(e);
  await r.promises.mkdir(n, { recursive: true, mode: 448 });
  let i = `${e}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    let s = await r.promises.open(i, "w", 384);
    try {
      await s.writeFile(JSON.stringify(t, null, 2)), await s.sync();
    } finally {
      await s.close();
    }
    await r.promises.rename(i, e);
  } catch (s) {
    throw await r.promises.unlink(i).catch(() => {
    }), s;
  }
  try {
    let s = await r.promises.open(n, "r");
    try {
      await s.sync();
    } finally {
      await s.close();
    }
  } catch {
  }
}
async function A1(e) {
  if (!e.body) return "";
  let t = e.body.getReader(), r = [], o = 0;
  for (; ; ) {
    let { done: i, value: s } = await t.read();
    if (i) break;
    if (o + s.length > yk) {
      let a = yk - o;
      if (a > 0) r.push(s.subarray(0, a));
      await t.cancel();
      break;
    }
    r.push(s), o += s.length;
  }
  let n;
  if (r.length === 1) n = r[0];
  else {
    n = new Uint8Array(r.reduce((s, a) => s + a.length, 0));
    let i = 0;
    for (let s of r) n.set(s, i), i += s.length;
  }
  return new TextDecoder("utf-8").decode(n);
}
var he = class extends z {
  constructor(e, t = null, r = null, o = null) {
    super(e);
    this.statusCode = t, this.body = r, this.requestId = o;
  }
};
function sr() {
  return Math.floor(Date.now() / 1e3);
}
var qg = class {
  constructor(e, t) {
    this.cached = null, this.pendingRefresh = null, this.nextForce = false, this.lastAdvisoryError = 0, this.provider = e, this.onAdvisoryRefreshError = t;
  }
  async getToken() {
    let e = this.nextForce;
    this.nextForce = false;
    let t = this.cached;
    if (e || t == null) return (await this.refresh(e)).token;
    if (t.expiresAt == null) return t.token;
    let r = t.expiresAt - sr();
    if (r > Sk) return t.token;
    if (r > si) return this.backgroundRefresh(), t.token;
    return (await this.refresh()).token;
  }
  invalidate() {
    this.cached = null, this.nextForce = true;
  }
  refresh(e = false) {
    if (this.pendingRefresh && !e) return this.pendingRefresh;
    return this.doRefresh(e);
  }
  backgroundRefresh() {
    if (this.pendingRefresh) return;
    if (sr() - this.lastAdvisoryError < xk) return;
    this.doRefresh().catch((e) => {
      this.lastAdvisoryError = sr(), this.onAdvisoryRefreshError?.(e);
    });
  }
  doRefresh(e = false) {
    return this.pendingRefresh = this.provider(e ? { forceRefresh: true } : void 0).then((t) => (this.cached = t, this.pendingRefresh = null, t), (t) => {
      throw this.pendingRefresh = null, t;
    }), this.pendingRefresh;
  }
};
var ge = (e) => {
  if (typeof globalThis.process < "u") return globalThis.process.env?.[e]?.trim() || void 0;
  if (typeof globalThis.Deno < "u") return globalThis.Deno.env?.get?.(e)?.trim() || void 0;
  return;
};
function Ek(e) {
  let t = 0;
  for (let n of e) t += n.length;
  let r = new Uint8Array(t), o = 0;
  for (let n of e) r.set(n, o), o += n.length;
  return r;
}
var wk;
function ai(e) {
  let t;
  return (wk ?? (t = new globalThis.TextEncoder(), wk = t.encode.bind(t)))(e);
}
var kk;
function Vg(e) {
  let t;
  return (kk ?? (t = new globalThis.TextDecoder(), kk = t.decode.bind(t)))(e);
}
var ju = { off: 0, error: 200, warn: 300, info: 400, debug: 500 };
var Zg = (e, t, r) => {
  if (!e) return;
  if (sk(ju, e)) return e;
  Fe(r).warn(`${t} was set to ${JSON.stringify(e)}, expected one of ${JSON.stringify(Object.keys(ju))}`);
  return;
};
function fa() {
}
function Nu(e, t, r) {
  if (!t || ju[e] > ju[r]) return fa;
  else return t[e].bind(t);
}
var O1 = { error: fa, warn: fa, info: fa, debug: fa };
var Pk = /* @__PURE__ */ new WeakMap();
function Fe(e) {
  let t = e.logger, r = e.logLevel ?? "off";
  if (!t) return O1;
  let o = Pk.get(t);
  if (o && o[0] === r) return o[1];
  let n = { error: Nu("error", t, r), warn: Nu("warn", t, r), info: Nu("info", t, r), debug: Nu("debug", t, r) };
  return Pk.set(t, [r, n]), n;
}
var jr = (e) => {
  if (e.options) e.options = { ...e.options }, delete e.options.headers;
  if (e.headers) e.headers = Object.fromEntries((e.headers instanceof Headers ? [...e.headers] : Object.entries(e.headers)).map(([t, r]) => [t, t.toLowerCase() === "x-api-key" || t.toLowerCase() === "authorization" || t.toLowerCase() === "cookie" || t.toLowerCase() === "set-cookie" ? "***" : r]));
  if ("retryOfRequestLogID" in e) {
    if (e.retryOfRequestLogID) e.retryOf = e.retryOfRequestLogID;
    delete e.retryOfRequestLogID;
  }
  return e;
};
var Uu = "1.0";
var C1 = /^[A-Za-z0-9_.-]+$/;
function Tk(e) {
  if (!e) throw Error("profile name is empty");
  if (e === "." || e === "..") throw Error(`profile name "${e}" is not allowed`);
  if (e.includes("/") || e.includes("\\")) throw Error(`profile name "${e}" must not contain path separators`);
  if (!C1.test(e)) throw Error(`profile name "${e}" contains disallowed characters (allowed: letters, digits, '_', '.', '-')`);
}
var Ik = async (e) => {
  var t, r;
  let o = await Wg();
  if (o === null) return null;
  let n = e ?? await $k();
  if (n === null) return null;
  Tk(n);
  let i = await import("node:fs"), a = (await import("node:path")).join(o, "configs", `${n}.json`), c;
  try {
    c = await i.promises.readFile(a, "utf-8");
  } catch (p) {
    if (p?.code !== "ENOENT") throw Error(`failed to read config file ${a}: ${p}`);
    c = null;
  }
  if (c === null) {
    let p = ge("ANTHROPIC_ORGANIZATION_ID"), f = ge("ANTHROPIC_IDENTITY_TOKEN_FILE"), m = ge("ANTHROPIC_FEDERATION_RULE_ID");
    if (m && p) return { fromFile: false, config: { organization_id: p, workspace_id: ge("ANTHROPIC_WORKSPACE_ID"), base_url: ge("ANTHROPIC_BASE_URL"), authentication: { type: "oidc_federation", federation_rule_id: m, service_account_id: ge("ANTHROPIC_SERVICE_ACCOUNT_ID"), identity_token: f ? { source: "file", path: f } : void 0, scope: ge("ANTHROPIC_SCOPE") } } };
    return null;
  }
  let u;
  try {
    u = JSON.parse(c);
  } catch (p) {
    throw Error(`failed to parse config file ${a}: ${p}`);
  }
  if (!u.authentication) throw Error(`config file ${a} is missing "authentication"`);
  let d = u.authentication.type;
  if (d !== "oidc_federation" && d !== "user_oauth") throw Error(`authentication.type "${d}" is not a known authentication type`);
  if (u.organization_id ?? (u.organization_id = ge("ANTHROPIC_ORGANIZATION_ID")), u.workspace_id ?? (u.workspace_id = ge("ANTHROPIC_WORKSPACE_ID")), u.base_url ?? (u.base_url = ge("ANTHROPIC_BASE_URL")), (t = u.authentication).scope ?? (t.scope = ge("ANTHROPIC_SCOPE")), u.authentication.type === "oidc_federation") {
    if (!u.authentication.identity_token) {
      let p = ge("ANTHROPIC_IDENTITY_TOKEN_FILE");
      if (p) u.authentication.identity_token = { source: "file", path: p };
    }
    if (!u.authentication.federation_rule_id) u.authentication.federation_rule_id = ge("ANTHROPIC_FEDERATION_RULE_ID") ?? "";
    (r = u.authentication).service_account_id ?? (r.service_account_id = ge("ANTHROPIC_SERVICE_ACCOUNT_ID"));
  }
  return { config: u, fromFile: true };
};
var Rk = async (e, t) => {
  if (e?.authentication.credentials_path) return e.authentication.credentials_path;
  let r = await Wg();
  if (!r) return null;
  let o = t ?? await $k();
  if (!o) return null;
  return Tk(o), (await import("node:path")).join(r, "credentials", `${o}.json`);
};
var Wg = async () => {
  if (!M1()) return null;
  let e = await import("node:path"), t = ge("ANTHROPIC_CONFIG_DIR");
  if (t) return t;
  if (da()["X-Stainless-OS"] === "Windows") {
    let i = ge("APPDATA");
    if (i) return e.join(i, "Anthropic");
    let s = ge("USERPROFILE");
    if (s) return e.join(s, "AppData", "Roaming", "Anthropic");
    return null;
  }
  let o = ge("XDG_CONFIG_HOME");
  if (o) return e.join(o, "anthropic");
  let n = ge("HOME");
  if (n) return e.join(n, ".config", "anthropic");
  return null;
};
var M1 = () => {
  let e = da()["X-Stainless-Runtime"];
  return e === "node" || e === "deno";
};
var $k = async () => {
  let e = await Wg();
  if (!e) return null;
  let t = ge("ANTHROPIC_PROFILE");
  if (t) return t;
  let r = await import("node:fs"), n = (await import("node:path")).join(e, "active_config");
  try {
    return (await r.promises.readFile(n, "utf-8")).trim() || "default";
  } catch (i) {
    if (i?.code !== "ENOENT") throw Error(`failed to read ${n}: ${i}`);
    return "default";
  }
};
function Kg(e) {
  if (!e) throw new z("Identity token file path is empty");
  return async () => {
    let t = await import("node:fs"), r;
    try {
      r = await t.promises.readFile(e, "utf-8");
    } catch (n) {
      throw new z(`Failed to read identity token file at ${e}: ${n}`);
    }
    let o = r.trim();
    if (!o) throw new z(`Identity token file at ${e} is empty`);
    return o;
  };
}
function Ak(e) {
  if (!e) throw new z("Identity token value is empty");
  return () => e;
}
function Ok(e) {
  return async () => {
    Ou(e.baseURL);
    let t = await e.identityTokenProvider();
    if (t.length > 16384) throw new he(`Identity token is ${Math.ceil(t.length / 1024)} KiB, exceeds the 16 KiB assertion limit`);
    let r = { grant_type: bk, assertion: t, federation_rule_id: e.federationRuleId, organization_id: e.organizationId };
    if (e.serviceAccountId) r.service_account_id = e.serviceAccountId;
    if (e.workspaceId) r.workspace_id = e.workspaceId;
    let o = `${e.baseURL}${Au}`, n;
    try {
      n = await e.fetch(o, { method: "POST", headers: { "Content-Type": "application/json", "anthropic-beta": `${oo},${vk}`, "User-Agent": e.userAgent || `anthropic-sdk-typescript/${Zt} oidcFederationProvider` }, body: JSON.stringify(r) });
    } catch (c) {
      throw new he(`Failed to reach token endpoint ${o}: ${c}`);
    }
    let i = n.headers.get("Request-Id");
    if (!n.ok) {
      let c = await n.text().catch(() => ""), u = vt(c), d = "";
      if (n.status === 401) d = ` Ensure your federation rule matches your identity token. ${e.workspaceId ? "" : "If your federation rule is scoped to multiple workspaces, set the ANTHROPIC_WORKSPACE_ID environment variable, the 'workspace_id' config key, or the `workspaceId` option. "}View your authentication events in the Workload identity page of Claude Console for more details.`;
      throw new he(`Token exchange failed with status ${n.status}${i ? ` (request-id ${i})` : ""}: ${u}${d}`, n.status, u, i);
    }
    let s = await Cu(n, i), a = Number(s.expires_in);
    if (!Number.isFinite(a)) throw new he(`Token endpoint response missing required fields: ${JSON.stringify(vt(s))}`, n.status, vt(s), i);
    return { token: s.access_token, expiresAt: sr() + a };
  };
}
function Ck(e) {
  return async (t) => {
    let r = await import("node:fs");
    await Mu(e.credentialsPath, e.onSafetyWarning);
    let o;
    try {
      o = await r.promises.readFile(e.credentialsPath, "utf-8");
    } catch (y) {
      throw new he(`Credentials file not found at ${e.credentialsPath}: ${y}`);
    }
    let n;
    try {
      n = JSON.parse(o);
    } catch (y) {
      throw new he(`Credentials file at ${e.credentialsPath} is not valid JSON: ${y}`);
    }
    let i = n.access_token;
    if (!i) throw new he(`Credentials file at ${e.credentialsPath} must include 'access_token'`);
    let s = n.expires_at;
    if (!t?.forceRefresh && (s == null || sr() < s - si)) return { token: i, expiresAt: s ?? null };
    let a = n.refresh_token;
    if (!e.clientId || !a) throw new he(`Access token at ${e.credentialsPath} has expired and no refresh is available (client_id ${e.clientId ? "set" : "empty"}, refresh_token ${a ? "set" : "empty"})`);
    Ou(e.baseURL);
    let c = { grant_type: _k, refresh_token: a, client_id: e.clientId }, u = `${e.baseURL}${Au}`, d;
    try {
      d = await e.fetch(u, { method: "POST", headers: { "Content-Type": "application/json", "anthropic-beta": oo, "User-Agent": e.userAgent || `anthropic-sdk-typescript/${Zt} userOAuthProvider` }, body: JSON.stringify(c) });
    } catch (y) {
      throw new he(`User OAuth refresh failed to reach token endpoint: ${y}`);
    }
    let p = d.headers.get("Request-Id");
    if (!d.ok) {
      let y = await d.text().catch(() => "");
      throw new he(`User OAuth refresh failed (HTTP ${d.status}): ${vt(y)}`, d.status, vt(y), p);
    }
    let f = await Cu(d, p), m = Number(f.expires_in);
    if (!Number.isFinite(m)) throw new he(`User OAuth refresh response missing or invalid expires_in: ${JSON.stringify(vt(f))}`, d.status, vt(f), p);
    let g = sr() + m, h = f.refresh_token || a;
    return await Du(e.credentialsPath, { ...n, version: Uu, type: "oauth_token", access_token: f.access_token, expires_at: g, refresh_token: h }), { token: f.access_token, expiresAt: g };
  };
}
function Gg(e, t) {
  let r = e.authentication.credentials_path ?? null, o = (e.base_url || t.baseURL).replace(/\/+$/, ""), n = D1(e, r, o, t), i = {};
  if (e.workspace_id && e.authentication.type === "user_oauth") i["anthropic-workspace-id"] = e.workspace_id;
  return { provider: n, extraHeaders: i, baseURL: e.base_url || void 0 };
}
async function Mk(e, t) {
  let r = await Ik(t);
  if (!r) return null;
  let { config: o, fromFile: n } = r, i = o.authentication.credentials_path || !n ? o : { ...o, authentication: { ...o.authentication, credentials_path: await Rk(o, t) ?? void 0 } };
  return Gg(i, e);
}
function D1(e, t, r, o) {
  switch (e.authentication.type) {
    case "oidc_federation": {
      let n = e.authentication, i = N1(n);
      if (!i) throw new he("oidc_federation config requires an identity token (set authentication.identity_token, ANTHROPIC_IDENTITY_TOKEN_FILE, or ANTHROPIC_IDENTITY_TOKEN)");
      if (!n.federation_rule_id) throw new he("oidc_federation config requires 'federation_rule_id'. Set it in authentication.federation_rule_id in your profile, or via ANTHROPIC_FEDERATION_RULE_ID (profile takes precedence).");
      if (!e.organization_id) throw new he("oidc_federation config requires organization_id (set ANTHROPIC_ORGANIZATION_ID or config.organization_id)");
      let s = Ok({ identityTokenProvider: i, federationRuleId: n.federation_rule_id, organizationId: e.organization_id, serviceAccountId: n.service_account_id, workspaceId: e.workspace_id, baseURL: r, fetch: o.fetch, userAgent: o.userAgent });
      if (t) return j1(s, t, o.onCacheWriteError, o.onSafetyWarning);
      return s;
    }
    case "user_oauth": {
      if (!t) throw new he("user_oauth config requires authentication.credentials_path (or load via a profile so it defaults to <config_dir>/credentials/<profile>.json)");
      return Ck({ credentialsPath: t, clientId: e.authentication.client_id, baseURL: r, fetch: o.fetch, userAgent: o.userAgent, onSafetyWarning: o.onSafetyWarning });
    }
    default: {
      let n = e.authentication.type;
      throw new he(`authentication.type "${n}" is not a known authentication type`);
    }
  }
}
function N1(e) {
  if (e.identity_token) {
    let o = e.identity_token.source;
    if (o !== "file") throw new he(`identity_token.source "${o}" is not supported by this SDK version (only "file")`);
    if (!e.identity_token.path) throw new he('identity_token.source "file" requires a non-empty path');
    return Kg(e.identity_token.path);
  }
  let t = ge("ANTHROPIC_IDENTITY_TOKEN_FILE");
  if (t) return Kg(t);
  let r = ge("ANTHROPIC_IDENTITY_TOKEN");
  if (r) return Ak(r);
  return null;
}
function j1(e, t, r, o) {
  return async (n) => {
    let i = await import("node:fs");
    await Mu(t, o);
    let s;
    try {
      let c = await i.promises.readFile(t, "utf-8");
      s = JSON.parse(c);
      let u = s?.access_token;
      if (u && !n?.forceRefresh) {
        let d = s?.expires_at;
        if (d == null || sr() < d - si) return { token: u, expiresAt: d ?? null };
      }
    } catch (c) {
      if (c?.code !== "ENOENT" && !(c instanceof SyntaxError)) r?.(c);
    }
    let a = await e(n);
    try {
      await Du(t, { ...s ?? {}, version: Uu, type: "oauth_token", access_token: a.token, expires_at: a.expiresAt });
    } catch (c) {
      r?.(c);
    }
    return a;
  };
}
var Ct;
var Mt;
var yn = class {
  constructor() {
    Ct.set(this, void 0), Mt.set(this, void 0), N(this, Ct, new Uint8Array(), "f"), N(this, Mt, null, "f");
  }
  decode(e) {
    if (e == null) return [];
    let t = e instanceof ArrayBuffer ? new Uint8Array(e) : typeof e === "string" ? ai(e) : e;
    N(this, Ct, Ek([_(this, Ct, "f"), t]), "f");
    let r = [], o;
    while ((o = U1(_(this, Ct, "f"), _(this, Mt, "f"))) != null) {
      if (o.carriage && _(this, Mt, "f") == null) {
        N(this, Mt, o.index, "f");
        continue;
      }
      if (_(this, Mt, "f") != null && (o.index !== _(this, Mt, "f") + 1 || o.carriage)) {
        r.push(Vg(_(this, Ct, "f").subarray(0, _(this, Mt, "f") - 1))), N(this, Ct, _(this, Ct, "f").subarray(_(this, Mt, "f")), "f"), N(this, Mt, null, "f");
        continue;
      }
      let n = _(this, Mt, "f") !== null ? o.preceding - 1 : o.preceding, i = Vg(_(this, Ct, "f").subarray(0, n));
      r.push(i), N(this, Ct, _(this, Ct, "f").subarray(o.index), "f"), N(this, Mt, null, "f");
    }
    return r;
  }
  flush() {
    if (!_(this, Ct, "f").length) return [];
    return this.decode(`
`);
  }
};
Ct = /* @__PURE__ */ new WeakMap(), Mt = /* @__PURE__ */ new WeakMap();
yn.NEWLINE_CHARS = /* @__PURE__ */ new Set([`
`, "\r"]);
yn.NEWLINE_REGEXP = /\r\n|[\n\r]/g;
function U1(e, t) {
  for (let n = t ?? 0; n < e.length; n++) {
    if (e[n] === 10) return { preceding: n, index: n + 1, carriage: false };
    if (e[n] === 13) return { preceding: n, index: n + 1, carriage: true };
  }
  return null;
}
function Dk(e) {
  for (let o = 0; o < e.length - 1; o++) {
    if (e[o] === 10 && e[o + 1] === 10) return o + 2;
    if (e[o] === 13 && e[o + 1] === 13) return o + 2;
    if (e[o] === 13 && e[o + 1] === 10 && o + 3 < e.length && e[o + 2] === 13 && e[o + 3] === 10) return o + 4;
  }
  return -1;
}
var ma;
var Dt = class _Dt {
  constructor(e, t, r) {
    this.iterator = e, ma.set(this, void 0), this.controller = t, N(this, ma, r, "f");
  }
  static fromSSEResponse(e, t, r) {
    let o = false, n = r ? Fe(r) : console;
    async function* i() {
      if (o) throw new z("Cannot iterate over a consumed stream, use `.tee()` to split the stream.");
      o = true;
      let s = false;
      try {
        for await (let a of z1(e, t)) {
          if (a.event === "completion") try {
            yield JSON.parse(a.data);
          } catch (c) {
            throw n.error("Could not parse message into JSON:", a.data), n.error("From chunk:", a.raw), c;
          }
          if (a.event === "message_start" || a.event === "message_delta" || a.event === "message_stop" || a.event === "content_block_start" || a.event === "content_block_delta" || a.event === "content_block_stop" || a.event === "message" || a.event === "user.message" || a.event === "user.interrupt" || a.event === "user.tool_confirmation" || a.event === "user.custom_tool_result" || a.event === "agent.message" || a.event === "agent.thinking" || a.event === "agent.tool_use" || a.event === "agent.tool_result" || a.event === "agent.mcp_tool_use" || a.event === "agent.mcp_tool_result" || a.event === "agent.custom_tool_use" || a.event === "agent.thread_context_compacted" || a.event === "session.status_running" || a.event === "session.status_idle" || a.event === "session.status_rescheduled" || a.event === "session.status_terminated" || a.event === "session.error" || a.event === "session.deleted" || a.event === "span.model_request_start" || a.event === "span.model_request_end") try {
            yield JSON.parse(a.data);
          } catch (c) {
            throw n.error("Could not parse message into JSON:", a.data), n.error("From chunk:", a.raw), c;
          }
          if (a.event === "ping") continue;
          if (a.event === "error") {
            let c = Ru(a.data) ?? a.data, u = c?.error?.type;
            throw new Ke(void 0, c, void 0, e.headers, u);
          }
        }
        s = true;
      } catch (a) {
        if (Nr(a)) return;
        throw a;
      } finally {
        if (!s) t.abort();
      }
    }
    return new _Dt(i, t, r);
  }
  static fromReadableStream(e, t, r) {
    let o = false;
    async function* n() {
      let s = new yn(), a = pa(e);
      for await (let c of a) for (let u of s.decode(c)) yield u;
      for (let c of s.flush()) yield c;
    }
    async function* i() {
      if (o) throw new z("Cannot iterate over a consumed stream, use `.tee()` to split the stream.");
      o = true;
      let s = false;
      try {
        for await (let a of n()) {
          if (s) continue;
          if (a) yield JSON.parse(a);
        }
        s = true;
      } catch (a) {
        if (Nr(a)) return;
        throw a;
      } finally {
        if (!s) t.abort();
      }
    }
    return new _Dt(i, t, r);
  }
  [(ma = /* @__PURE__ */ new WeakMap(), Symbol.asyncIterator)]() {
    return this.iterator();
  }
  tee() {
    let e = [], t = [], r = this.iterator(), o = (n) => ({ next: () => {
      if (n.length === 0) {
        let i = r.next();
        e.push(i), t.push(i);
      }
      return n.shift();
    } });
    return [new _Dt(() => o(e), this.controller, _(this, ma, "f")), new _Dt(() => o(t), this.controller, _(this, ma, "f"))];
  }
  toReadableStream() {
    let e = this, t;
    return Hg({ async start() {
      t = e[Symbol.asyncIterator]();
    }, async pull(r) {
      try {
        let { value: o, done: n } = await t.next();
        if (n) return r.close();
        let i = ai(JSON.stringify(o) + `
`);
        r.enqueue(i);
      } catch (o) {
        r.error(o);
      }
    }, async cancel() {
      await t.return?.();
    } });
  }
};
async function* z1(e, t) {
  if (!e.body) {
    if (t.abort(), typeof globalThis.navigator < "u" && globalThis.navigator.product === "ReactNative") throw new z("The default react-native fetch implementation does not support streaming. Please use expo/fetch: https://docs.expo.dev/versions/latest/sdk/expo/#expofetch-api");
    throw new z("Attempted to iterate over a response with no body");
  }
  let r = new Nk(), o = new yn(), n = pa(e.body);
  for await (let i of L1(n)) for (let s of o.decode(i)) {
    let a = r.decode(s);
    if (a) yield a;
  }
  for (let i of o.flush()) {
    let s = r.decode(i);
    if (s) yield s;
  }
}
async function* L1(e) {
  let t = new Uint8Array();
  for await (let r of e) {
    if (r == null) continue;
    let o = r instanceof ArrayBuffer ? new Uint8Array(r) : typeof r === "string" ? ai(r) : r, n = new Uint8Array(t.length + o.length);
    n.set(t), n.set(o, t.length), t = n;
    let i;
    while ((i = Dk(t)) !== -1) yield t.slice(0, i), t = t.slice(i);
  }
  if (t.length > 0) yield t;
}
var Nk = class {
  constructor() {
    this.event = null, this.data = [], this.chunks = [];
  }
  decode(e) {
    if (e.endsWith("\r")) e = e.substring(0, e.length - 1);
    if (!e) {
      if (!this.event && !this.data.length) return null;
      let n = { event: this.event, data: this.data.join(`
`), raw: this.chunks };
      return this.event = null, this.data = [], this.chunks = [], n;
    }
    if (this.chunks.push(e), e.startsWith(":")) return null;
    let [t, r, o] = F1(e, ":");
    if (o.startsWith(" ")) o = o.substring(1);
    if (t === "event") this.event = o;
    else if (t === "data") this.data.push(o);
    return null;
  }
};
function F1(e, t) {
  let r = e.indexOf(t);
  if (r !== -1) return [e.substring(0, r), t, e.substring(r + t.length)];
  return [e, "", ""];
}
async function zu(e, t) {
  let { response: r, requestLogID: o, retryOfRequestLogID: n, startTime: i } = t, s = await (async () => {
    if (t.options.stream) {
      if (Fe(e).debug("response", r.status, r.url, r.headers, r.body), t.options.__streamClass) return t.options.__streamClass.fromSSEResponse(r, t.controller);
      return Dt.fromSSEResponse(r, t.controller);
    }
    if (r.status === 204) return null;
    if (t.options.__binaryResponse) return r;
    let c = r.headers.get("content-type")?.split(";")[0]?.trim();
    if (c?.includes("application/json") || c?.endsWith("+json")) {
      if (r.headers.get("content-length") === "0") return;
      let f = await r.json();
      return Jg(f, r);
    }
    return await r.text();
  })();
  return Fe(e).debug(`[${o}] response parsed`, jr({ retryOfRequestLogID: n, url: r.url, status: r.status, body: s, durationMs: Date.now() - i })), s;
}
function Jg(e, t) {
  if (!e || typeof e !== "object" || Array.isArray(e)) return e;
  return Object.defineProperty(e, "_request_id", { value: t.headers.get("request-id"), enumerable: false });
}
var ga;
var io = class _io extends Promise {
  constructor(e, t, r = zu) {
    super((o) => {
      o(null);
    });
    this.responsePromise = t, this.parseResponse = r, ga.set(this, void 0), N(this, ga, e, "f");
  }
  _thenUnwrap(e) {
    return new _io(_(this, ga, "f"), this.responsePromise, async (t, r) => Jg(e(await this.parseResponse(t, r), r), r.response));
  }
  asResponse() {
    return this.responsePromise.then((e) => e.response);
  }
  async withResponse() {
    let [e, t] = await Promise.all([this.parse(), this.asResponse()]);
    return { data: e, response: t, request_id: t.headers.get("request-id") };
  }
  parse() {
    if (!this.parsedPromise) this.parsedPromise = this.responsePromise.then((e) => this.parseResponse(_(this, ga, "f"), e));
    return this.parsedPromise;
  }
  then(e, t) {
    return this.parse().then(e, t);
  }
  catch(e) {
    return this.parse().catch(e);
  }
  finally(e) {
    return this.parse().finally(e);
  }
};
ga = /* @__PURE__ */ new WeakMap();
var Lu;
var Xg = class {
  constructor(e, t, r, o) {
    Lu.set(this, void 0), N(this, Lu, e, "f"), this.options = o, this.response = t, this.body = r;
  }
  hasNextPage() {
    if (!this.getPaginatedItems().length) return false;
    return this.nextPageRequestOptions() != null;
  }
  async getNextPage() {
    let e = this.nextPageRequestOptions();
    if (!e) throw new z("No next page expected; please check `.hasNextPage()` before calling `.getNextPage()`.");
    return await _(this, Lu, "f").requestAPIList(this.constructor, e);
  }
  async *iterPages() {
    let e = this;
    yield e;
    while (e.hasNextPage()) e = await e.getNextPage(), yield e;
  }
  async *[(Lu = /* @__PURE__ */ new WeakMap(), Symbol.asyncIterator)]() {
    for await (let e of this.iterPages()) for (let t of e.getPaginatedItems()) yield t;
  }
};
var Fu = class extends io {
  constructor(e, t, r) {
    super(e, t, async (o, n) => new r(o, n.response, await zu(o, n), n.options));
  }
  async *[Symbol.asyncIterator]() {
    let e = await this;
    for await (let t of e) yield t;
  }
};
var ar = class extends Xg {
  constructor(e, t, r, o) {
    super(e, t, r, o);
    this.data = r.data || [], this.has_more = r.has_more || false, this.first_id = r.first_id || null, this.last_id = r.last_id || null;
  }
  getPaginatedItems() {
    return this.data ?? [];
  }
  hasNextPage() {
    if (this.has_more === false) return false;
    return super.hasNextPage();
  }
  nextPageRequestOptions() {
    if (this.options.query?.before_id) {
      let t = this.first_id;
      if (!t) return null;
      return { ...this.options, query: { ...Iu(this.options.query), before_id: t } };
    }
    let e = this.last_id;
    if (!e) return null;
    return { ...this.options, query: { ...Iu(this.options.query), after_id: e } };
  }
};
var ye = class extends Xg {
  constructor(e, t, r, o) {
    super(e, t, r, o);
    this.data = r.data || [], this.next_page = r.next_page || null;
  }
  getPaginatedItems() {
    return this.data ?? [];
  }
  nextPageRequestOptions() {
    let e = this.next_page;
    if (!e) return null;
    return { ...this.options, query: { ...Iu(this.options.query), page: e } };
  }
};
var Qg = () => {
  if (typeof File > "u") {
    let { process: e } = globalThis, t = typeof e?.versions?.node === "string" && parseInt(e.versions.node.split(".")) < 20;
    throw Error("`File` is not defined as a global, which is required for file uploads." + (t ? " Update to Node 20 LTS or newer, or set `globalThis.File` to `import('node:buffer').File`." : ""));
  }
};
function so(e, t, r) {
  return Qg(), new File(e, t ?? "unknown_file", r);
}
function ha(e, t) {
  let r = typeof e === "object" && e !== null && ("name" in e && e.name && String(e.name) || "url" in e && e.url && String(e.url) || "filename" in e && e.filename && String(e.filename) || "path" in e && e.path && String(e.path)) || "";
  return t ? r.split(/[\\/]/).pop() || void 0 : r;
}
var eh = (e) => e != null && typeof e === "object" && typeof e[Symbol.asyncIterator] === "function";
var ci = async (e, t, r = true) => ({ ...e, body: await q1(e.body, t, r) });
var jk = /* @__PURE__ */ new WeakMap();
function B1(e) {
  let t = typeof e === "function" ? e : e.fetch, r = jk.get(t);
  if (r) return r;
  let o = (async () => {
    try {
      let n = "Response" in t ? t.Response : (await t("data:,")).constructor, i = new FormData();
      if (i.toString() === await new n(i).text()) return false;
      return true;
    } catch {
      return true;
    }
  })();
  return jk.set(t, o), o;
}
var q1 = async (e, t, r = true) => {
  if (!await B1(t)) throw TypeError("The provided fetch function does not support file uploads with the current global FormData class.");
  let o = new FormData();
  return await Promise.all(Object.entries(e || {}).map(([n, i]) => Yg(o, n, i, r))), o;
};
var V1 = (e) => e instanceof Blob && "name" in e;
var Yg = async (e, t, r, o) => {
  if (r === void 0) return;
  if (r == null) throw TypeError(`Received null for "${t}"; to pass null in FormData, you must use the string 'null'`);
  if (typeof r === "string" || typeof r === "number" || typeof r === "boolean") e.append(t, String(r));
  else if (r instanceof Response) {
    let n = {}, i = r.headers.get("Content-Type");
    if (i) n = { type: i };
    e.append(t, so([await r.blob()], ha(r, o), n));
  } else if (eh(r)) e.append(t, so([await new Response($u(r)).blob()], ha(r, o)));
  else if (V1(r)) e.append(t, so([r], ha(r, o), { type: r.type }));
  else if (Array.isArray(r)) await Promise.all(r.map((n) => Yg(e, t + "[]", n, o)));
  else if (typeof r === "object") await Promise.all(Object.entries(r).map(([n, i]) => Yg(e, `${t}[${n}]`, i, o)));
  else throw TypeError(`Invalid value given to form, expected a string, number, boolean, object, Array, File or Blob but got ${r} instead`);
};
var Uk = (e) => e != null && typeof e === "object" && typeof e.size === "number" && typeof e.type === "string" && typeof e.text === "function" && typeof e.slice === "function" && typeof e.arrayBuffer === "function";
var Z1 = (e) => e != null && typeof e === "object" && typeof e.name === "string" && typeof e.lastModified === "number" && Uk(e);
var W1 = (e) => e != null && typeof e === "object" && typeof e.url === "string" && typeof e.blob === "function";
async function Hu(e, t, r) {
  if (Qg(), e = await e, t || (t = ha(e, true)), Z1(e)) {
    if (e instanceof File && t == null && r == null) return e;
    return so([await e.arrayBuffer()], t ?? e.name, { type: e.type, lastModified: e.lastModified, ...r });
  }
  if (W1(e)) {
    let n = await e.blob();
    return t || (t = new URL(e.url).pathname.split(/[\\/]/).pop()), so(await th(n), t, r);
  }
  let o = await th(e);
  if (!r?.type) {
    let n = o.find((i) => typeof i === "object" && "type" in i && i.type);
    if (typeof n === "string") r = { ...r, type: n };
  }
  return so(o, t, r);
}
async function th(e) {
  let t = [];
  if (typeof e === "string" || ArrayBuffer.isView(e) || e instanceof ArrayBuffer) t.push(e);
  else if (Uk(e)) t.push(e instanceof Blob ? e : await e.arrayBuffer());
  else if (eh(e)) for await (let r of e) t.push(...await th(r));
  else {
    let r = e?.constructor?.name;
    throw Error(`Unexpected data type: ${typeof e}${r ? `; constructor: ${r}` : ""}${K1(e)}`);
  }
  return t;
}
function K1(e) {
  if (typeof e !== "object" || e === null) return "";
  return `; props: [${Object.getOwnPropertyNames(e).map((r) => `"${r}"`).join(", ")}]`;
}
var J = class {
  constructor(e) {
    this._client = e;
  }
};
var zk = Symbol.for("brand.privateNullableHeaders");
function* J1(e) {
  if (!e) return;
  if (zk in e) {
    let { values: o, nulls: n } = e;
    yield* o.entries();
    for (let i of n) yield [i, null];
    return;
  }
  let t = false, r;
  if (e instanceof Headers) r = e.entries();
  else if (Lg(e)) r = e;
  else t = true, r = Object.entries(e ?? {});
  for (let o of r) {
    let n = o[0];
    if (typeof n !== "string") throw TypeError("expected header name to be a string");
    let i = Lg(o[1]) ? o[1] : [o[1]], s = false;
    for (let a of i) {
      if (a === void 0) continue;
      if (t && !s) s = true, yield [n, null];
      yield [n, a];
    }
  }
}
var E = (e) => {
  let t = new Headers(), r = /* @__PURE__ */ new Set();
  for (let o of e) {
    let n = /* @__PURE__ */ new Set();
    for (let [i, s] of J1(o)) {
      let a = i.toLowerCase();
      if (!n.has(a)) t.delete(i), n.add(a);
      if (s === null) t.delete(i), r.add(a);
      else t.append(i, s), r.delete(a);
    }
  }
  return { [zk]: true, values: t, nulls: r };
};
function Fk(e) {
  return e.replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:@]+/g, encodeURIComponent);
}
var Lk = Object.freeze(/* @__PURE__ */ Object.create(null));
var X1 = (e = Fk) => function(r, ...o) {
  if (r.length === 1) return r[0];
  let n = false, i = [], s = r.reduce((d, p, f) => {
    if (/[?#]/.test(p)) n = true;
    let m = o[f], g = (n ? encodeURIComponent : e)("" + m);
    if (f !== o.length && (m == null || typeof m === "object" && m.toString === Object.getPrototypeOf(Object.getPrototypeOf(m.hasOwnProperty ?? Lk) ?? Lk)?.toString)) g = m + "", i.push({ start: d.length + p.length, length: g.length, error: `Value of type ${Object.prototype.toString.call(m).slice(8, -1)} is not a valid path parameter` });
    return d + p + (f === o.length ? "" : g);
  }, ""), a = s.split(/[?#]/, 1)[0], c = /(?<=^|\/)(?:\.|%2e){1,2}(?=\/|$)/gi, u;
  while ((u = c.exec(a)) !== null) i.push({ start: u.index, length: u[0].length, error: `Value "${u[0]}" can't be safely passed as a path parameter` });
  if (i.sort((d, p) => d.start - p.start), i.length > 0) {
    let d = 0, p = i.reduce((f, m) => {
      let g = " ".repeat(m.start - d), h = "^".repeat(m.length);
      return d = m.start + m.length, f + g + h;
    }, "");
    throw new z(`Path parameters result in path with invalid segments:
${i.map((f) => f.error).join(`
`)}
${s}
${p}`);
  }
  return s;
};
var M = X1(Fk);
var ya = class extends J {
  create(e, t) {
    let { betas: r, ...o } = e;
    return this._client.post("/v1/environments?beta=true", { body: o, ...t, headers: E([{ "anthropic-beta": [...r ?? [], "managed-agents-2026-04-01"].toString() }, t?.headers]) });
  }
  retrieve(e, t = {}, r) {
    let { betas: o } = t ?? {};
    return this._client.get(M`/v1/environments/${e}?beta=true`, { ...r, headers: E([{ "anthropic-beta": [...o ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
  update(e, t, r) {
    let { betas: o, ...n } = t;
    return this._client.post(M`/v1/environments/${e}?beta=true`, { body: n, ...r, headers: E([{ "anthropic-beta": [...o ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
  list(e = {}, t) {
    let { betas: r, ...o } = e ?? {};
    return this._client.getAPIList("/v1/environments?beta=true", ye, { query: o, ...t, headers: E([{ "anthropic-beta": [...r ?? [], "managed-agents-2026-04-01"].toString() }, t?.headers]) });
  }
  delete(e, t = {}, r) {
    let { betas: o } = t ?? {};
    return this._client.delete(M`/v1/environments/${e}?beta=true`, { ...r, headers: E([{ "anthropic-beta": [...o ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
  archive(e, t = {}, r) {
    let { betas: o } = t ?? {};
    return this._client.post(M`/v1/environments/${e}/archive?beta=true`, { ...r, headers: E([{ "anthropic-beta": [...o ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
};
var ba = Symbol("anthropic.sdk.stainlessHelper");
function Bu(e) {
  return typeof e === "object" && e !== null && ba in e;
}
function rh(e, t) {
  let r = /* @__PURE__ */ new Set();
  if (e) {
    for (let o of e) if (Bu(o)) r.add(o[ba]);
  }
  if (t) for (let o of t) {
    if (Bu(o)) r.add(o[ba]);
    if (Array.isArray(o.content)) {
      for (let n of o.content) if (Bu(n)) r.add(n[ba]);
    }
  }
  return Array.from(r);
}
function qu(e, t) {
  let r = rh(e, t);
  if (r.length === 0) return {};
  return { "x-stainless-helper": r.join(", ") };
}
function Hk(e) {
  if (Bu(e)) return { "x-stainless-helper": e[ba] };
  return {};
}
var _a = class extends J {
  list(e = {}, t) {
    let { betas: r, ...o } = e ?? {};
    return this._client.getAPIList("/v1/files?beta=true", ar, { query: o, ...t, headers: E([{ "anthropic-beta": [...r ?? [], "files-api-2025-04-14"].toString() }, t?.headers]) });
  }
  delete(e, t = {}, r) {
    let { betas: o } = t ?? {};
    return this._client.delete(M`/v1/files/${e}?beta=true`, { ...r, headers: E([{ "anthropic-beta": [...o ?? [], "files-api-2025-04-14"].toString() }, r?.headers]) });
  }
  download(e, t = {}, r) {
    let { betas: o } = t ?? {};
    return this._client.get(M`/v1/files/${e}/content?beta=true`, { ...r, headers: E([{ "anthropic-beta": [...o ?? [], "files-api-2025-04-14"].toString(), Accept: "application/binary" }, r?.headers]), __binaryResponse: true });
  }
  retrieveMetadata(e, t = {}, r) {
    let { betas: o } = t ?? {};
    return this._client.get(M`/v1/files/${e}?beta=true`, { ...r, headers: E([{ "anthropic-beta": [...o ?? [], "files-api-2025-04-14"].toString() }, r?.headers]) });
  }
  upload(e, t) {
    let { betas: r, ...o } = e;
    return this._client.post("/v1/files?beta=true", ci({ body: o, ...t, headers: E([{ "anthropic-beta": [...r ?? [], "files-api-2025-04-14"].toString() }, Hk(o.file), t?.headers]) }, this._client));
  }
};
var va = class extends J {
  retrieve(e, t = {}, r) {
    let { betas: o } = t ?? {};
    return this._client.get(M`/v1/models/${e}?beta=true`, { ...r, headers: E([{ ...o?.toString() != null ? { "anthropic-beta": o?.toString() } : void 0 }, r?.headers]) });
  }
  list(e = {}, t) {
    let { betas: r, ...o } = e ?? {};
    return this._client.getAPIList("/v1/models?beta=true", ar, { query: o, ...t, headers: E([{ ...r?.toString() != null ? { "anthropic-beta": r?.toString() } : void 0 }, t?.headers]) });
  }
};
var Sa = class extends J {
  create(e, t) {
    let { betas: r, ...o } = e;
    return this._client.post("/v1/user_profiles?beta=true", { body: o, ...t, headers: E([{ "anthropic-beta": [...r ?? [], "user-profiles-2026-03-24"].toString() }, t?.headers]) });
  }
  retrieve(e, t = {}, r) {
    let { betas: o } = t ?? {};
    return this._client.get(M`/v1/user_profiles/${e}?beta=true`, { ...r, headers: E([{ "anthropic-beta": [...o ?? [], "user-profiles-2026-03-24"].toString() }, r?.headers]) });
  }
  update(e, t, r) {
    let { betas: o, ...n } = t;
    return this._client.post(M`/v1/user_profiles/${e}?beta=true`, { body: n, ...r, headers: E([{ "anthropic-beta": [...o ?? [], "user-profiles-2026-03-24"].toString() }, r?.headers]) });
  }
  list(e = {}, t) {
    let { betas: r, ...o } = e ?? {};
    return this._client.getAPIList("/v1/user_profiles?beta=true", ye, { query: o, ...t, headers: E([{ "anthropic-beta": [...r ?? [], "user-profiles-2026-03-24"].toString() }, t?.headers]) });
  }
  createEnrollmentURL(e, t = {}, r) {
    let { betas: o } = t ?? {};
    return this._client.post(M`/v1/user_profiles/${e}/enrollment_url?beta=true`, { ...r, headers: E([{ "anthropic-beta": [...o ?? [], "user-profiles-2026-03-24"].toString() }, r?.headers]) });
  }
};
var xa = class extends J {
  list(e, t = {}, r) {
    let { betas: o, ...n } = t ?? {};
    return this._client.getAPIList(M`/v1/agents/${e}/versions?beta=true`, ye, { query: n, ...r, headers: E([{ "anthropic-beta": [...o ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
};
var li = class extends J {
  constructor() {
    super(...arguments);
    this.versions = new xa(this._client);
  }
  create(e, t) {
    let { betas: r, ...o } = e;
    return this._client.post("/v1/agents?beta=true", { body: o, ...t, headers: E([{ "anthropic-beta": [...r ?? [], "managed-agents-2026-04-01"].toString() }, t?.headers]) });
  }
  retrieve(e, t = {}, r) {
    let { betas: o, ...n } = t ?? {};
    return this._client.get(M`/v1/agents/${e}?beta=true`, { query: n, ...r, headers: E([{ "anthropic-beta": [...o ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
  update(e, t, r) {
    let { betas: o, ...n } = t;
    return this._client.post(M`/v1/agents/${e}?beta=true`, { body: n, ...r, headers: E([{ "anthropic-beta": [...o ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
  list(e = {}, t) {
    let { betas: r, ...o } = e ?? {};
    return this._client.getAPIList("/v1/agents?beta=true", ye, { query: o, ...t, headers: E([{ "anthropic-beta": [...r ?? [], "managed-agents-2026-04-01"].toString() }, t?.headers]) });
  }
  archive(e, t = {}, r) {
    let { betas: o } = t ?? {};
    return this._client.post(M`/v1/agents/${e}/archive?beta=true`, { ...r, headers: E([{ "anthropic-beta": [...o ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
};
li.Versions = xa;
var wa = class extends J {
  create(e, t, r) {
    let { view: o, betas: n, ...i } = t;
    return this._client.post(M`/v1/memory_stores/${e}/memories?beta=true`, { query: { view: o }, body: i, ...r, headers: E([{ "anthropic-beta": [...n ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
  retrieve(e, t, r) {
    let { memory_store_id: o, betas: n, ...i } = t;
    return this._client.get(M`/v1/memory_stores/${o}/memories/${e}?beta=true`, { query: i, ...r, headers: E([{ "anthropic-beta": [...n ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
  update(e, t, r) {
    let { memory_store_id: o, view: n, betas: i, ...s } = t;
    return this._client.post(M`/v1/memory_stores/${o}/memories/${e}?beta=true`, { query: { view: n }, body: s, ...r, headers: E([{ "anthropic-beta": [...i ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
  list(e, t = {}, r) {
    let { betas: o, ...n } = t ?? {};
    return this._client.getAPIList(M`/v1/memory_stores/${e}/memories?beta=true`, ye, { query: n, ...r, headers: E([{ "anthropic-beta": [...o ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
  delete(e, t, r) {
    let { memory_store_id: o, expected_content_sha256: n, betas: i } = t;
    return this._client.delete(M`/v1/memory_stores/${o}/memories/${e}?beta=true`, { query: { expected_content_sha256: n }, ...r, headers: E([{ "anthropic-beta": [...i ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
};
var ka = class extends J {
  retrieve(e, t, r) {
    let { memory_store_id: o, betas: n, ...i } = t;
    return this._client.get(M`/v1/memory_stores/${o}/memory_versions/${e}?beta=true`, { query: i, ...r, headers: E([{ "anthropic-beta": [...n ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
  list(e, t = {}, r) {
    let { betas: o, ...n } = t ?? {};
    return this._client.getAPIList(M`/v1/memory_stores/${e}/memory_versions?beta=true`, ye, { query: n, ...r, headers: E([{ "anthropic-beta": [...o ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
  redact(e, t, r) {
    let { memory_store_id: o, betas: n } = t;
    return this._client.post(M`/v1/memory_stores/${o}/memory_versions/${e}/redact?beta=true`, { ...r, headers: E([{ "anthropic-beta": [...n ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
};
var ao = class extends J {
  constructor() {
    super(...arguments);
    this.memories = new wa(this._client), this.memoryVersions = new ka(this._client);
  }
  create(e, t) {
    let { betas: r, ...o } = e;
    return this._client.post("/v1/memory_stores?beta=true", { body: o, ...t, headers: E([{ "anthropic-beta": [...r ?? [], "managed-agents-2026-04-01"].toString() }, t?.headers]) });
  }
  retrieve(e, t = {}, r) {
    let { betas: o } = t ?? {};
    return this._client.get(M`/v1/memory_stores/${e}?beta=true`, { ...r, headers: E([{ "anthropic-beta": [...o ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
  update(e, t, r) {
    let { betas: o, ...n } = t;
    return this._client.post(M`/v1/memory_stores/${e}?beta=true`, { body: n, ...r, headers: E([{ "anthropic-beta": [...o ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
  list(e = {}, t) {
    let { betas: r, ...o } = e ?? {};
    return this._client.getAPIList("/v1/memory_stores?beta=true", ye, { query: o, ...t, headers: E([{ "anthropic-beta": [...r ?? [], "managed-agents-2026-04-01"].toString() }, t?.headers]) });
  }
  delete(e, t = {}, r) {
    let { betas: o } = t ?? {};
    return this._client.delete(M`/v1/memory_stores/${e}?beta=true`, { ...r, headers: E([{ "anthropic-beta": [...o ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
  archive(e, t = {}, r) {
    let { betas: o } = t ?? {};
    return this._client.post(M`/v1/memory_stores/${e}/archive?beta=true`, { ...r, headers: E([{ "anthropic-beta": [...o ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
};
ao.Memories = wa;
ao.MemoryVersions = ka;
var ui = class _ui {
  constructor(e, t) {
    this.iterator = e, this.controller = t;
  }
  async *decoder() {
    let e = new yn();
    for await (let t of this.iterator) for (let r of e.decode(t)) yield JSON.parse(r);
    for (let t of e.flush()) yield JSON.parse(t);
  }
  [Symbol.asyncIterator]() {
    return this.decoder();
  }
  static fromResponse(e, t) {
    if (!e.body) {
      if (t.abort(), typeof globalThis.navigator < "u" && globalThis.navigator.product === "ReactNative") throw new z("The default react-native fetch implementation does not support streaming. Please use expo/fetch: https://docs.expo.dev/versions/latest/sdk/expo/#expofetch-api");
      throw new z("Attempted to iterate over a response with no body");
    }
    return new _ui(pa(e.body), t);
  }
};
var Ea = class extends J {
  create(e, t) {
    let { betas: r, ...o } = e;
    return this._client.post("/v1/messages/batches?beta=true", { body: o, ...t, headers: E([{ "anthropic-beta": [...r ?? [], "message-batches-2024-09-24"].toString() }, t?.headers]) });
  }
  retrieve(e, t = {}, r) {
    let { betas: o } = t ?? {};
    return this._client.get(M`/v1/messages/batches/${e}?beta=true`, { ...r, headers: E([{ "anthropic-beta": [...o ?? [], "message-batches-2024-09-24"].toString() }, r?.headers]) });
  }
  list(e = {}, t) {
    let { betas: r, ...o } = e ?? {};
    return this._client.getAPIList("/v1/messages/batches?beta=true", ar, { query: o, ...t, headers: E([{ "anthropic-beta": [...r ?? [], "message-batches-2024-09-24"].toString() }, t?.headers]) });
  }
  delete(e, t = {}, r) {
    let { betas: o } = t ?? {};
    return this._client.delete(M`/v1/messages/batches/${e}?beta=true`, { ...r, headers: E([{ "anthropic-beta": [...o ?? [], "message-batches-2024-09-24"].toString() }, r?.headers]) });
  }
  cancel(e, t = {}, r) {
    let { betas: o } = t ?? {};
    return this._client.post(M`/v1/messages/batches/${e}/cancel?beta=true`, { ...r, headers: E([{ "anthropic-beta": [...o ?? [], "message-batches-2024-09-24"].toString() }, r?.headers]) });
  }
  async results(e, t = {}, r) {
    let o = await this.retrieve(e);
    if (!o.results_url) throw new z(`No batch \`results_url\`; Has it finished processing? ${o.processing_status} - ${o.id}`);
    let { betas: n } = t ?? {};
    return this._client.get(o.results_url, { ...r, headers: E([{ "anthropic-beta": [...n ?? [], "message-batches-2024-09-24"].toString(), Accept: "application/binary" }, r?.headers]), stream: true, __binaryResponse: true })._thenUnwrap((i, s) => ui.fromResponse(s.response, s.controller));
  }
};
var Vu = { "claude-opus-4-20250514": 8192, "claude-opus-4-0": 8192, "claude-4-opus-20250514": 8192, "anthropic.claude-opus-4-20250514-v1:0": 8192, "claude-opus-4@20250514": 8192, "claude-opus-4-1-20250805": 8192, "anthropic.claude-opus-4-1-20250805-v1:0": 8192, "claude-opus-4-1@20250805": 8192 };
function Bk(e) {
  return e?.output_format ?? e?.output_config?.format;
}
function nh(e, t, r) {
  let o = Bk(t);
  if (!t || !("parse" in (o ?? {}))) return { ...e, content: e.content.map((n) => {
    if (n.type === "text") {
      let i = Object.defineProperty({ ...n }, "parsed_output", { value: null, enumerable: false });
      return Object.defineProperty(i, "parsed", { get() {
        return r.logger.warn("The `parsed` property on `text` blocks is deprecated, please use `parsed_output` instead."), null;
      }, enumerable: false });
    }
    return n;
  }), parsed_output: null };
  return oh(e, t, r);
}
function oh(e, t, r) {
  let o = null, n = e.content.map((i) => {
    if (i.type === "text") {
      let s = cF(t, i.text);
      if (o === null) o = s;
      let a = Object.defineProperty({ ...i }, "parsed_output", { value: s, enumerable: false });
      return Object.defineProperty(a, "parsed", { get() {
        return r.logger.warn("The `parsed` property on `text` blocks is deprecated, please use `parsed_output` instead."), s;
      }, enumerable: false });
    }
    return i;
  });
  return { ...e, content: n, parsed_output: o };
}
function cF(e, t) {
  let r = Bk(e);
  if (r?.type !== "json_schema") return null;
  try {
    if ("parse" in r) return r.parse(t);
    return JSON.parse(t);
  } catch (o) {
    throw new z(`Failed to parse structured output: ${o}`);
  }
}
var lF = (e) => {
  let t = 0, r = [];
  while (t < e.length) {
    let o = e[t];
    if (o === "\\") {
      t++;
      continue;
    }
    if (o === "{") {
      r.push({ type: "brace", value: "{" }), t++;
      continue;
    }
    if (o === "}") {
      r.push({ type: "brace", value: "}" }), t++;
      continue;
    }
    if (o === "[") {
      r.push({ type: "paren", value: "[" }), t++;
      continue;
    }
    if (o === "]") {
      r.push({ type: "paren", value: "]" }), t++;
      continue;
    }
    if (o === ":") {
      r.push({ type: "separator", value: ":" }), t++;
      continue;
    }
    if (o === ",") {
      r.push({ type: "delimiter", value: "," }), t++;
      continue;
    }
    if (o === '"') {
      let a = "", c = false;
      o = e[++t];
      while (o !== '"') {
        if (t === e.length) {
          c = true;
          break;
        }
        if (o === "\\") {
          if (t++, t === e.length) {
            c = true;
            break;
          }
          a += o + e[t], o = e[++t];
        } else a += o, o = e[++t];
      }
      if (o = e[++t], !c) r.push({ type: "string", value: a });
      continue;
    }
    if (o && /\s/.test(o)) {
      t++;
      continue;
    }
    let i = /[0-9]/;
    if (o && i.test(o) || o === "-" || o === ".") {
      let a = "";
      if (o === "-") a += o, o = e[++t];
      while (o && i.test(o) || o === ".") a += o, o = e[++t];
      r.push({ type: "number", value: a });
      continue;
    }
    let s = /[a-z]/i;
    if (o && s.test(o)) {
      let a = "";
      while (o && s.test(o)) {
        if (t === e.length) break;
        a += o, o = e[++t];
      }
      if (a == "true" || a == "false" || a === "null") r.push({ type: "name", value: a });
      else {
        t++;
        continue;
      }
      continue;
    }
    t++;
  }
  return r;
};
var di = (e) => {
  if (e.length === 0) return e;
  let t = e[e.length - 1];
  switch (t.type) {
    case "separator":
      return e = e.slice(0, e.length - 1), di(e);
      break;
    case "number":
      let r = t.value[t.value.length - 1];
      if (r === "." || r === "-") return e = e.slice(0, e.length - 1), di(e);
    case "string":
      let o = e[e.length - 2];
      if (o?.type === "delimiter") return e = e.slice(0, e.length - 1), di(e);
      else if (o?.type === "brace" && o.value === "{") return e = e.slice(0, e.length - 1), di(e);
      break;
    case "delimiter":
      return e = e.slice(0, e.length - 1), di(e);
      break;
  }
  return e;
};
var uF = (e) => {
  let t = [];
  if (e.map((r) => {
    if (r.type === "brace") if (r.value === "{") t.push("}");
    else t.splice(t.lastIndexOf("}"), 1);
    if (r.type === "paren") if (r.value === "[") t.push("]");
    else t.splice(t.lastIndexOf("]"), 1);
  }), t.length > 0) t.reverse().map((r) => {
    if (r === "}") e.push({ type: "brace", value: "}" });
    else if (r === "]") e.push({ type: "paren", value: "]" });
  });
  return e;
};
var dF = (e) => {
  let t = "";
  return e.map((r) => {
    switch (r.type) {
      case "string":
        t += '"' + r.value + '"';
        break;
      default:
        t += r.value;
        break;
    }
  }), t;
};
var Zu = (e) => JSON.parse(dF(uF(di(lF(e)))));
var Wt;
var bn;
var pi;
var Pa;
var Wu;
var Ta;
var Ia;
var Ku;
var Ra;
var Ur;
var $a;
var Gu;
var Ju;
var co;
var Xu;
var Yu;
var Aa;
var ih;
var qk;
var Qu;
var sh;
var ah;
var ch;
var Vk;
var Zk = "__json_buf";
function Wk(e) {
  return e.type === "tool_use" || e.type === "server_tool_use" || e.type === "mcp_tool_use";
}
var Oa = class _Oa {
  constructor(e, t) {
    Wt.add(this), this.messages = [], this.receivedMessages = [], bn.set(this, void 0), pi.set(this, null), this.controller = new AbortController(), Pa.set(this, void 0), Wu.set(this, () => {
    }), Ta.set(this, () => {
    }), Ia.set(this, void 0), Ku.set(this, () => {
    }), Ra.set(this, () => {
    }), Ur.set(this, {}), $a.set(this, false), Gu.set(this, false), Ju.set(this, false), co.set(this, false), Xu.set(this, void 0), Yu.set(this, void 0), Aa.set(this, void 0), Qu.set(this, (r) => {
      if (N(this, Gu, true, "f"), Nr(r)) r = new et();
      if (r instanceof et) return N(this, Ju, true, "f"), this._emit("abort", r);
      if (r instanceof z) return this._emit("error", r);
      if (r instanceof Error) {
        let o = new z(r.message);
        return o.cause = r, this._emit("error", o);
      }
      return this._emit("error", new z(String(r)));
    }), N(this, Pa, new Promise((r, o) => {
      N(this, Wu, r, "f"), N(this, Ta, o, "f");
    }), "f"), N(this, Ia, new Promise((r, o) => {
      N(this, Ku, r, "f"), N(this, Ra, o, "f");
    }), "f"), _(this, Pa, "f").catch(() => {
    }), _(this, Ia, "f").catch(() => {
    }), N(this, pi, e, "f"), N(this, Aa, t?.logger ?? console, "f");
  }
  get response() {
    return _(this, Xu, "f");
  }
  get request_id() {
    return _(this, Yu, "f");
  }
  async withResponse() {
    N(this, co, true, "f");
    let e = await _(this, Pa, "f");
    if (!e) throw Error("Could not resolve a `Response` object");
    return { data: this, response: e, request_id: e.headers.get("request-id") };
  }
  static fromReadableStream(e) {
    let t = new _Oa(null);
    return t._run(() => t._fromReadableStream(e)), t;
  }
  static createMessage(e, t, r, { logger: o } = {}) {
    let n = new _Oa(t, { logger: o });
    for (let i of t.messages) n._addMessageParam(i);
    return N(n, pi, { ...t, stream: true }, "f"), n._run(() => n._createMessage(e, { ...t, stream: true }, { ...r, headers: { ...r?.headers, "X-Stainless-Helper-Method": "stream" } })), n;
  }
  _run(e) {
    e().then(() => {
      this._emitFinal(), this._emit("end");
    }, _(this, Qu, "f"));
  }
  _addMessageParam(e) {
    this.messages.push(e);
  }
  _addMessage(e, t = true) {
    if (this.receivedMessages.push(e), t) this._emit("message", e);
  }
  async _createMessage(e, t, r) {
    let o = r?.signal, n;
    if (o) {
      if (o.aborted) this.controller.abort();
      n = this.controller.abort.bind(this.controller), o.addEventListener("abort", n);
    }
    try {
      _(this, Wt, "m", sh).call(this);
      let { response: i, data: s } = await e.create({ ...t, stream: true }, { ...r, signal: this.controller.signal }).withResponse();
      this._connected(i);
      for await (let a of s) _(this, Wt, "m", ah).call(this, a);
      if (s.controller.signal?.aborted) throw new et();
      _(this, Wt, "m", ch).call(this);
    } finally {
      if (o && n) o.removeEventListener("abort", n);
    }
  }
  _connected(e) {
    if (this.ended) return;
    N(this, Xu, e, "f"), N(this, Yu, e?.headers.get("request-id"), "f"), _(this, Wu, "f").call(this, e), this._emit("connect");
  }
  get ended() {
    return _(this, $a, "f");
  }
  get errored() {
    return _(this, Gu, "f");
  }
  get aborted() {
    return _(this, Ju, "f");
  }
  abort() {
    this.controller.abort();
  }
  on(e, t) {
    return (_(this, Ur, "f")[e] || (_(this, Ur, "f")[e] = [])).push({ listener: t }), this;
  }
  off(e, t) {
    let r = _(this, Ur, "f")[e];
    if (!r) return this;
    let o = r.findIndex((n) => n.listener === t);
    if (o >= 0) r.splice(o, 1);
    return this;
  }
  once(e, t) {
    return (_(this, Ur, "f")[e] || (_(this, Ur, "f")[e] = [])).push({ listener: t, once: true }), this;
  }
  emitted(e) {
    return new Promise((t, r) => {
      if (N(this, co, true, "f"), e !== "error") this.once("error", r);
      this.once(e, t);
    });
  }
  async done() {
    N(this, co, true, "f"), await _(this, Ia, "f");
  }
  get currentMessage() {
    return _(this, bn, "f");
  }
  async finalMessage() {
    return await this.done(), _(this, Wt, "m", ih).call(this);
  }
  async finalText() {
    return await this.done(), _(this, Wt, "m", qk).call(this);
  }
  _emit(e, ...t) {
    if (_(this, $a, "f")) return;
    if (e === "end") N(this, $a, true, "f"), _(this, Ku, "f").call(this);
    let r = _(this, Ur, "f")[e];
    if (r) _(this, Ur, "f")[e] = r.filter((o) => !o.once), r.forEach(({ listener: o }) => o(...t));
    if (e === "abort") {
      let o = t[0];
      if (!_(this, co, "f") && !r?.length) Promise.reject(o);
      _(this, Ta, "f").call(this, o), _(this, Ra, "f").call(this, o), this._emit("end");
      return;
    }
    if (e === "error") {
      let o = t[0];
      if (!_(this, co, "f") && !r?.length) Promise.reject(o);
      _(this, Ta, "f").call(this, o), _(this, Ra, "f").call(this, o), this._emit("end");
    }
  }
  _emitFinal() {
    if (this.receivedMessages.at(-1)) this._emit("finalMessage", _(this, Wt, "m", ih).call(this));
  }
  async _fromReadableStream(e, t) {
    let r = t?.signal, o;
    if (r) {
      if (r.aborted) this.controller.abort();
      o = this.controller.abort.bind(this.controller), r.addEventListener("abort", o);
    }
    try {
      _(this, Wt, "m", sh).call(this), this._connected(null);
      let n = Dt.fromReadableStream(e, this.controller);
      for await (let i of n) _(this, Wt, "m", ah).call(this, i);
      if (n.controller.signal?.aborted) throw new et();
      _(this, Wt, "m", ch).call(this);
    } finally {
      if (r && o) r.removeEventListener("abort", o);
    }
  }
  [(bn = /* @__PURE__ */ new WeakMap(), pi = /* @__PURE__ */ new WeakMap(), Pa = /* @__PURE__ */ new WeakMap(), Wu = /* @__PURE__ */ new WeakMap(), Ta = /* @__PURE__ */ new WeakMap(), Ia = /* @__PURE__ */ new WeakMap(), Ku = /* @__PURE__ */ new WeakMap(), Ra = /* @__PURE__ */ new WeakMap(), Ur = /* @__PURE__ */ new WeakMap(), $a = /* @__PURE__ */ new WeakMap(), Gu = /* @__PURE__ */ new WeakMap(), Ju = /* @__PURE__ */ new WeakMap(), co = /* @__PURE__ */ new WeakMap(), Xu = /* @__PURE__ */ new WeakMap(), Yu = /* @__PURE__ */ new WeakMap(), Aa = /* @__PURE__ */ new WeakMap(), Qu = /* @__PURE__ */ new WeakMap(), Wt = /* @__PURE__ */ new WeakSet(), ih = function() {
    if (this.receivedMessages.length === 0) throw new z("stream ended without producing a Message with role=assistant");
    return this.receivedMessages.at(-1);
  }, qk = function() {
    if (this.receivedMessages.length === 0) throw new z("stream ended without producing a Message with role=assistant");
    let t = this.receivedMessages.at(-1).content.filter((r) => r.type === "text").map((r) => r.text);
    if (t.length === 0) throw new z("stream ended without producing a content block with type=text");
    return t.join(" ");
  }, sh = function() {
    if (this.ended) return;
    N(this, bn, void 0, "f");
  }, ah = function(t) {
    if (this.ended) return;
    let r = _(this, Wt, "m", Vk).call(this, t);
    switch (this._emit("streamEvent", t, r), t.type) {
      case "content_block_delta": {
        let o = r.content.at(-1);
        switch (t.delta.type) {
          case "text_delta": {
            if (o.type === "text") this._emit("text", t.delta.text, o.text || "");
            break;
          }
          case "citations_delta": {
            if (o.type === "text") this._emit("citation", t.delta.citation, o.citations ?? []);
            break;
          }
          case "input_json_delta": {
            if (Wk(o) && o.input) this._emit("inputJson", t.delta.partial_json, o.input);
            break;
          }
          case "thinking_delta": {
            if (o.type === "thinking") this._emit("thinking", t.delta.thinking, o.thinking);
            break;
          }
          case "signature_delta": {
            if (o.type === "thinking") this._emit("signature", o.signature);
            break;
          }
          case "compaction_delta": {
            if (o.type === "compaction" && o.content) this._emit("compaction", o.content);
            break;
          }
          default:
            Kk(t.delta);
        }
        break;
      }
      case "message_stop": {
        this._addMessageParam(r), this._addMessage(nh(r, _(this, pi, "f"), { logger: _(this, Aa, "f") }), true);
        break;
      }
      case "content_block_stop": {
        this._emit("contentBlock", r.content.at(-1));
        break;
      }
      case "message_start": {
        N(this, bn, r, "f");
        break;
      }
      case "content_block_start":
      case "message_delta":
        break;
    }
  }, ch = function() {
    if (this.ended) throw new z("stream has ended, this shouldn't happen");
    let t = _(this, bn, "f");
    if (!t) throw new z("request ended without sending any chunks");
    return N(this, bn, void 0, "f"), nh(t, _(this, pi, "f"), { logger: _(this, Aa, "f") });
  }, Vk = function(t) {
    let r = _(this, bn, "f");
    if (t.type === "message_start") {
      if (r) throw new z(`Unexpected event order, got ${t.type} before receiving "message_stop"`);
      return t.message;
    }
    if (!r) throw new z(`Unexpected event order, got ${t.type} before "message_start"`);
    switch (t.type) {
      case "message_stop":
        return r;
      case "message_delta":
        if (r.container = t.delta.container, r.stop_reason = t.delta.stop_reason, r.stop_sequence = t.delta.stop_sequence, r.usage.output_tokens = t.usage.output_tokens, r.context_management = t.context_management, t.usage.input_tokens != null) r.usage.input_tokens = t.usage.input_tokens;
        if (t.usage.cache_creation_input_tokens != null) r.usage.cache_creation_input_tokens = t.usage.cache_creation_input_tokens;
        if (t.usage.cache_read_input_tokens != null) r.usage.cache_read_input_tokens = t.usage.cache_read_input_tokens;
        if (t.usage.server_tool_use != null) r.usage.server_tool_use = t.usage.server_tool_use;
        if (t.usage.iterations != null) r.usage.iterations = t.usage.iterations;
        return r;
      case "content_block_start":
        return r.content.push(t.content_block), r;
      case "content_block_delta": {
        let o = r.content.at(t.index);
        switch (t.delta.type) {
          case "text_delta": {
            if (o?.type === "text") r.content[t.index] = { ...o, text: (o.text || "") + t.delta.text };
            break;
          }
          case "citations_delta": {
            if (o?.type === "text") r.content[t.index] = { ...o, citations: [...o.citations ?? [], t.delta.citation] };
            break;
          }
          case "input_json_delta": {
            if (o && Wk(o)) {
              let n = o[Zk] || "";
              n += t.delta.partial_json;
              let i = { ...o };
              if (Object.defineProperty(i, Zk, { value: n, enumerable: false, writable: true }), n) try {
                i.input = Zu(n);
              } catch (s) {
                let a = new z(`Unable to parse tool parameter JSON from model. Please retry your request or adjust your prompt. Error: ${s}. JSON: ${n}`);
                _(this, Qu, "f").call(this, a);
              }
              r.content[t.index] = i;
            }
            break;
          }
          case "thinking_delta": {
            if (o?.type === "thinking") r.content[t.index] = { ...o, thinking: o.thinking + t.delta.thinking };
            break;
          }
          case "signature_delta": {
            if (o?.type === "thinking") r.content[t.index] = { ...o, signature: t.delta.signature };
            break;
          }
          case "compaction_delta": {
            if (o?.type === "compaction") r.content[t.index] = { ...o, content: (o.content || "") + t.delta.content };
            break;
          }
          default:
            Kk(t.delta);
        }
        return r;
      }
      case "content_block_stop":
        return r;
    }
  }, Symbol.asyncIterator)]() {
    let e = [], t = [], r = false;
    return this.on("streamEvent", (o) => {
      let n = t.shift();
      if (n) n.resolve(o);
      else e.push(o);
    }), this.on("end", () => {
      r = true;
      for (let o of t) o.resolve(void 0);
      t.length = 0;
    }), this.on("abort", (o) => {
      r = true;
      for (let n of t) n.reject(o);
      t.length = 0;
    }), this.on("error", (o) => {
      r = true;
      for (let n of t) n.reject(o);
      t.length = 0;
    }), { next: async () => {
      if (!e.length) {
        if (r) return { value: void 0, done: true };
        return new Promise((n, i) => t.push({ resolve: n, reject: i })).then((n) => n ? { value: n, done: false } : { value: void 0, done: true });
      }
      return { value: e.shift(), done: false };
    }, return: async () => (this.abort(), { value: void 0, done: true }) };
  }
  toReadableStream() {
    return new Dt(this[Symbol.asyncIterator].bind(this), this.controller).toReadableStream();
  }
};
function Kk(e) {
}
var fi = class extends Error {
  constructor(e) {
    let t = typeof e === "string" ? e : e.map((r) => {
      if (r.type === "text") return r.text;
      return `[${r.type}]`;
    }).join(" ");
    super(t);
    this.name = "ToolError", this.content = e;
  }
};
var Gk = 1e5;
var Jk = `You have been working on the task described above but have not yet completed it. Write a continuation summary that will allow you (or another instance of yourself) to resume work efficiently in a future context window where the conversation history will be replaced with this summary. Your summary should be structured, concise, and actionable. Include:
1. Task Overview
The user's core request and success criteria
Any clarifications or constraints they specified
2. Current State
What has been completed so far
Files created, modified, or analyzed (with paths if relevant)
Key outputs or artifacts produced
3. Important Discoveries
Technical constraints or requirements uncovered
Decisions made and their rationale
Errors encountered and how they were resolved
What approaches were tried that didn't work (and why)
4. Next Steps
Specific actions needed to complete the task
Any blockers or open questions to resolve
Priority order if multiple steps remain
5. Context to Preserve
User preferences or style requirements
Domain-specific details that aren't obvious
Any promises made to the user
Be concise but complete\u2014err on the side of including information that would prevent duplicate work or repeated mistakes. Write in a way that enables immediate resumption of the task.
Wrap your summary in <summary></summary> tags.`;
var Ca;
var mi;
var lo;
var Ge;
var St;
var Nt;
var zr;
var _n;
var Ma;
var Xk;
var lh;
function Yk() {
  let e, t;
  return { promise: new Promise((o, n) => {
    e = o, t = n;
  }), resolve: e, reject: t };
}
var Da = class {
  constructor(e, t, r) {
    Ca.add(this), this.client = e, mi.set(this, false), lo.set(this, false), Ge.set(this, void 0), St.set(this, void 0), Nt.set(this, void 0), zr.set(this, void 0), _n.set(this, void 0), Ma.set(this, 0), N(this, Ge, { params: { ...t, messages: structuredClone(t.messages) } }, "f");
    let n = ["BetaToolRunner", ...rh(t.tools, t.messages)].join(", ");
    if (N(this, St, { ...r, headers: E([{ "x-stainless-helper": n }, r?.headers]) }, "f"), N(this, _n, Yk(), "f"), t.compactionControl?.enabled) console.warn('Anthropic: The `compactionControl` parameter is deprecated and will be removed in a future version. Use server-side compaction instead by passing `edits: [{ type: "compact_20260112" }]` in the params passed to `toolRunner()`. See https://platform.claude.com/docs/en/build-with-claude/compaction');
  }
  async *[(mi = /* @__PURE__ */ new WeakMap(), lo = /* @__PURE__ */ new WeakMap(), Ge = /* @__PURE__ */ new WeakMap(), St = /* @__PURE__ */ new WeakMap(), Nt = /* @__PURE__ */ new WeakMap(), zr = /* @__PURE__ */ new WeakMap(), _n = /* @__PURE__ */ new WeakMap(), Ma = /* @__PURE__ */ new WeakMap(), Ca = /* @__PURE__ */ new WeakSet(), Xk = async function() {
    let t = _(this, Ge, "f").params.compactionControl;
    if (!t || !t.enabled) return false;
    let r = 0;
    if (_(this, Nt, "f") !== void 0) try {
      let c = await _(this, Nt, "f");
      r = c.usage.input_tokens + (c.usage.cache_creation_input_tokens ?? 0) + (c.usage.cache_read_input_tokens ?? 0) + c.usage.output_tokens;
    } catch {
      return false;
    }
    let o = t.contextTokenThreshold ?? Gk;
    if (r < o) return false;
    let n = t.model ?? _(this, Ge, "f").params.model, i = t.summaryPrompt ?? Jk, s = _(this, Ge, "f").params.messages;
    if (s[s.length - 1].role === "assistant") {
      let c = s[s.length - 1];
      if (Array.isArray(c.content)) {
        let u = c.content.filter((d) => d.type !== "tool_use");
        if (u.length === 0) s.pop();
        else c.content = u;
      }
    }
    let a = await this.client.beta.messages.create({ model: n, messages: [...s, { role: "user", content: [{ type: "text", text: i }] }], max_tokens: _(this, Ge, "f").params.max_tokens }, { signal: _(this, St, "f").signal, headers: E([_(this, St, "f").headers, { "x-stainless-helper": "compaction" }]) });
    if (a.content[0]?.type !== "text") throw new z("Expected text response for compaction");
    return _(this, Ge, "f").params.messages = [{ role: "user", content: a.content }], true;
  }, Symbol.asyncIterator)]() {
    var e;
    if (_(this, mi, "f")) throw new z("Cannot iterate over a consumed stream");
    N(this, mi, true, "f"), N(this, lo, true, "f"), N(this, zr, void 0, "f");
    try {
      while (true) {
        let t;
        try {
          if (_(this, Ge, "f").params.max_iterations && _(this, Ma, "f") >= _(this, Ge, "f").params.max_iterations) break;
          N(this, lo, false, "f"), N(this, zr, void 0, "f"), N(this, Ma, (e = _(this, Ma, "f"), e++, e), "f"), N(this, Nt, void 0, "f");
          let { max_iterations: r, compactionControl: o, ...n } = _(this, Ge, "f").params;
          if (n.stream) t = this.client.beta.messages.stream({ ...n }, _(this, St, "f")), N(this, Nt, t.finalMessage(), "f"), _(this, Nt, "f").catch(() => {
          }), yield t;
          else N(this, Nt, this.client.beta.messages.create({ ...n, stream: false }, _(this, St, "f")), "f"), yield _(this, Nt, "f");
          if (!await _(this, Ca, "m", Xk).call(this)) {
            if (!_(this, lo, "f")) {
              let { role: a, content: c } = await _(this, Nt, "f");
              _(this, Ge, "f").params.messages.push({ role: a, content: c });
            }
            let s = await _(this, Ca, "m", lh).call(this, _(this, Ge, "f").params.messages.at(-1));
            if (s) _(this, Ge, "f").params.messages.push(s);
            else if (!_(this, lo, "f")) break;
          }
        } finally {
          if (t) t.abort();
        }
      }
      if (!_(this, Nt, "f")) throw new z("ToolRunner concluded without a message from the server");
      _(this, _n, "f").resolve(await _(this, Nt, "f"));
    } catch (t) {
      throw N(this, mi, false, "f"), _(this, _n, "f").promise.catch(() => {
      }), _(this, _n, "f").reject(t), N(this, _n, Yk(), "f"), t;
    }
  }
  setMessagesParams(e) {
    if (typeof e === "function") _(this, Ge, "f").params = e(_(this, Ge, "f").params);
    else _(this, Ge, "f").params = e;
    N(this, lo, true, "f"), N(this, zr, void 0, "f");
  }
  setRequestOptions(e) {
    if (typeof e === "function") N(this, St, e(_(this, St, "f")), "f");
    else N(this, St, { ..._(this, St, "f"), ...e }, "f");
  }
  async generateToolResponse(e = _(this, St, "f").signal) {
    let t = await _(this, Nt, "f") ?? this.params.messages.at(-1);
    if (!t) return null;
    return _(this, Ca, "m", lh).call(this, t, e);
  }
  done() {
    return _(this, _n, "f").promise;
  }
  async runUntilDone() {
    if (!_(this, mi, "f")) for await (let e of this) ;
    return this.done();
  }
  get params() {
    return _(this, Ge, "f").params;
  }
  pushMessages(...e) {
    this.setMessagesParams((t) => ({ ...t, messages: [...t.messages, ...e] }));
  }
  then(e, t) {
    return this.runUntilDone().then(e, t);
  }
};
lh = async function(t, r = _(this, St, "f").signal) {
  if (_(this, zr, "f") !== void 0) return _(this, zr, "f");
  return N(this, zr, pF(_(this, Ge, "f").params, t, { ..._(this, St, "f"), signal: r }), "f"), _(this, zr, "f");
};
async function pF(e, t = e.messages.at(-1), r) {
  if (!t || t.role !== "assistant" || !t.content || typeof t.content === "string") return null;
  let o = t.content.filter((i) => i.type === "tool_use");
  if (o.length === 0) return null;
  return { role: "user", content: await Promise.all(o.map(async (i) => {
    let s = e.tools.find((a) => ("name" in a ? a.name : a.mcp_server_name) === i.name);
    if (!s || !("run" in s)) return { type: "tool_result", tool_use_id: i.id, content: `Error: Tool '${i.name}' not found`, is_error: true };
    try {
      let a = i.input;
      if ("parse" in s && s.parse) a = s.parse(a);
      let c = await s.run(a, { toolUseBlock: i, signal: r?.signal });
      return { type: "tool_result", tool_use_id: i.id, content: c };
    } catch (a) {
      return { type: "tool_result", tool_use_id: i.id, content: a instanceof fi ? a.content : `Error: ${a instanceof Error ? a.message : String(a)}`, is_error: true };
    }
  })) };
}
var Qk = { "claude-1.3": "November 6th, 2024", "claude-1.3-100k": "November 6th, 2024", "claude-instant-1.1": "November 6th, 2024", "claude-instant-1.1-100k": "November 6th, 2024", "claude-instant-1.2": "November 6th, 2024", "claude-3-sonnet-20240229": "July 21st, 2025", "claude-3-opus-20240229": "January 5th, 2026", "claude-2.1": "July 21st, 2025", "claude-2.0": "July 21st, 2025", "claude-3-7-sonnet-latest": "February 19th, 2026", "claude-3-7-sonnet-20250219": "February 19th, 2026" };
var fF = ["claude-mythos-preview", "claude-opus-4-6"];
var vn = class extends J {
  constructor() {
    super(...arguments);
    this.batches = new Ea(this._client);
  }
  create(e, t) {
    let r = eE(e), { betas: o, ...n } = r;
    if (n.model in Qk) console.warn(`The model '${n.model}' is deprecated and will reach end-of-life on ${Qk[n.model]}
Please migrate to a newer model. Visit https://docs.anthropic.com/en/docs/resources/model-deprecations for more information.`);
    if (fF.includes(n.model) && n.thinking && n.thinking.type === "enabled") console.warn(`Using Claude with ${n.model} and 'thinking.type=enabled' is deprecated. Use 'thinking.type=adaptive' instead which results in better model performance in our testing: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking`);
    let i = this._client._options.timeout;
    if (!n.stream && i == null) {
      let a = Vu[n.model] ?? void 0;
      i = this._client.calculateNonstreamingTimeout(n.max_tokens, a);
    }
    let s = qu(n.tools, n.messages);
    return this._client.post("/v1/messages?beta=true", { body: n, timeout: i ?? 6e5, ...t, headers: E([{ ...o?.toString() != null ? { "anthropic-beta": o?.toString() } : void 0 }, s, t?.headers]), stream: r.stream ?? false });
  }
  parse(e, t) {
    return t = { ...t, headers: E([{ "anthropic-beta": [...e.betas ?? [], "structured-outputs-2025-12-15"].toString() }, t?.headers]) }, this.create(e, t).then((r) => oh(r, e, { logger: this._client.logger ?? console }));
  }
  stream(e, t) {
    return Oa.createMessage(this, e, t);
  }
  countTokens(e, t) {
    let r = eE(e), { betas: o, ...n } = r;
    return this._client.post("/v1/messages/count_tokens?beta=true", { body: n, ...t, headers: E([{ "anthropic-beta": [...o ?? [], "token-counting-2024-11-01"].toString() }, t?.headers]) });
  }
  toolRunner(e, t) {
    return new Da(this._client, e, t);
  }
};
function eE(e) {
  if (!e.output_format) return e;
  if (e.output_config?.format) throw new z("Both output_format and output_config.format were provided. Please use only output_config.format (output_format is deprecated).");
  let { output_format: t, ...r } = e;
  return { ...r, output_config: { ...e.output_config, format: t } };
}
vn.Batches = Ea;
vn.BetaToolRunner = Da;
vn.ToolError = fi;
var Na = class extends J {
  list(e, t = {}, r) {
    let { betas: o, ...n } = t ?? {};
    return this._client.getAPIList(M`/v1/sessions/${e}/events?beta=true`, ye, { query: n, ...r, headers: E([{ "anthropic-beta": [...o ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
  send(e, t, r) {
    let { betas: o, ...n } = t;
    return this._client.post(M`/v1/sessions/${e}/events?beta=true`, { body: n, ...r, headers: E([{ "anthropic-beta": [...o ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
  stream(e, t = {}, r) {
    let { betas: o } = t ?? {};
    return this._client.get(M`/v1/sessions/${e}/events/stream?beta=true`, { ...r, headers: E([{ "anthropic-beta": [...o ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]), stream: true });
  }
};
var ja = class extends J {
  retrieve(e, t, r) {
    let { session_id: o, betas: n } = t;
    return this._client.get(M`/v1/sessions/${o}/resources/${e}?beta=true`, { ...r, headers: E([{ "anthropic-beta": [...n ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
  update(e, t, r) {
    let { session_id: o, betas: n, ...i } = t;
    return this._client.post(M`/v1/sessions/${o}/resources/${e}?beta=true`, { body: i, ...r, headers: E([{ "anthropic-beta": [...n ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
  list(e, t = {}, r) {
    let { betas: o, ...n } = t ?? {};
    return this._client.getAPIList(M`/v1/sessions/${e}/resources?beta=true`, ye, { query: n, ...r, headers: E([{ "anthropic-beta": [...o ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
  delete(e, t, r) {
    let { session_id: o, betas: n } = t;
    return this._client.delete(M`/v1/sessions/${o}/resources/${e}?beta=true`, { ...r, headers: E([{ "anthropic-beta": [...n ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
  add(e, t, r) {
    let { betas: o, ...n } = t;
    return this._client.post(M`/v1/sessions/${e}/resources?beta=true`, { body: n, ...r, headers: E([{ "anthropic-beta": [...o ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
};
var uo = class extends J {
  constructor() {
    super(...arguments);
    this.events = new Na(this._client), this.resources = new ja(this._client);
  }
  create(e, t) {
    let { betas: r, ...o } = e;
    return this._client.post("/v1/sessions?beta=true", { body: o, ...t, headers: E([{ "anthropic-beta": [...r ?? [], "managed-agents-2026-04-01"].toString() }, t?.headers]) });
  }
  retrieve(e, t = {}, r) {
    let { betas: o } = t ?? {};
    return this._client.get(M`/v1/sessions/${e}?beta=true`, { ...r, headers: E([{ "anthropic-beta": [...o ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
  update(e, t, r) {
    let { betas: o, ...n } = t;
    return this._client.post(M`/v1/sessions/${e}?beta=true`, { body: n, ...r, headers: E([{ "anthropic-beta": [...o ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
  list(e = {}, t) {
    let { betas: r, ...o } = e ?? {};
    return this._client.getAPIList("/v1/sessions?beta=true", ye, { query: o, ...t, headers: E([{ "anthropic-beta": [...r ?? [], "managed-agents-2026-04-01"].toString() }, t?.headers]) });
  }
  delete(e, t = {}, r) {
    let { betas: o } = t ?? {};
    return this._client.delete(M`/v1/sessions/${e}?beta=true`, { ...r, headers: E([{ "anthropic-beta": [...o ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
  archive(e, t = {}, r) {
    let { betas: o } = t ?? {};
    return this._client.post(M`/v1/sessions/${e}/archive?beta=true`, { ...r, headers: E([{ "anthropic-beta": [...o ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
};
uo.Events = Na;
uo.Resources = ja;
var Ua = class extends J {
  create(e, t = {}, r) {
    let { betas: o, ...n } = t ?? {};
    return this._client.post(M`/v1/skills/${e}/versions?beta=true`, ci({ body: n, ...r, headers: E([{ "anthropic-beta": [...o ?? [], "skills-2025-10-02"].toString() }, r?.headers]) }, this._client));
  }
  retrieve(e, t, r) {
    let { skill_id: o, betas: n } = t;
    return this._client.get(M`/v1/skills/${o}/versions/${e}?beta=true`, { ...r, headers: E([{ "anthropic-beta": [...n ?? [], "skills-2025-10-02"].toString() }, r?.headers]) });
  }
  list(e, t = {}, r) {
    let { betas: o, ...n } = t ?? {};
    return this._client.getAPIList(M`/v1/skills/${e}/versions?beta=true`, ye, { query: n, ...r, headers: E([{ "anthropic-beta": [...o ?? [], "skills-2025-10-02"].toString() }, r?.headers]) });
  }
  delete(e, t, r) {
    let { skill_id: o, betas: n } = t;
    return this._client.delete(M`/v1/skills/${o}/versions/${e}?beta=true`, { ...r, headers: E([{ "anthropic-beta": [...n ?? [], "skills-2025-10-02"].toString() }, r?.headers]) });
  }
};
var gi = class extends J {
  constructor() {
    super(...arguments);
    this.versions = new Ua(this._client);
  }
  create(e = {}, t) {
    let { betas: r, ...o } = e ?? {};
    return this._client.post("/v1/skills?beta=true", ci({ body: o, ...t, headers: E([{ "anthropic-beta": [...r ?? [], "skills-2025-10-02"].toString() }, t?.headers]) }, this._client, false));
  }
  retrieve(e, t = {}, r) {
    let { betas: o } = t ?? {};
    return this._client.get(M`/v1/skills/${e}?beta=true`, { ...r, headers: E([{ "anthropic-beta": [...o ?? [], "skills-2025-10-02"].toString() }, r?.headers]) });
  }
  list(e = {}, t) {
    let { betas: r, ...o } = e ?? {};
    return this._client.getAPIList("/v1/skills?beta=true", ye, { query: o, ...t, headers: E([{ "anthropic-beta": [...r ?? [], "skills-2025-10-02"].toString() }, t?.headers]) });
  }
  delete(e, t = {}, r) {
    let { betas: o } = t ?? {};
    return this._client.delete(M`/v1/skills/${e}?beta=true`, { ...r, headers: E([{ "anthropic-beta": [...o ?? [], "skills-2025-10-02"].toString() }, r?.headers]) });
  }
};
gi.Versions = Ua;
var za = class extends J {
  create(e, t, r) {
    let { betas: o, ...n } = t;
    return this._client.post(M`/v1/vaults/${e}/credentials?beta=true`, { body: n, ...r, headers: E([{ "anthropic-beta": [...o ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
  retrieve(e, t, r) {
    let { vault_id: o, betas: n } = t;
    return this._client.get(M`/v1/vaults/${o}/credentials/${e}?beta=true`, { ...r, headers: E([{ "anthropic-beta": [...n ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
  update(e, t, r) {
    let { vault_id: o, betas: n, ...i } = t;
    return this._client.post(M`/v1/vaults/${o}/credentials/${e}?beta=true`, { body: i, ...r, headers: E([{ "anthropic-beta": [...n ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
  list(e, t = {}, r) {
    let { betas: o, ...n } = t ?? {};
    return this._client.getAPIList(M`/v1/vaults/${e}/credentials?beta=true`, ye, { query: n, ...r, headers: E([{ "anthropic-beta": [...o ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
  delete(e, t, r) {
    let { vault_id: o, betas: n } = t;
    return this._client.delete(M`/v1/vaults/${o}/credentials/${e}?beta=true`, { ...r, headers: E([{ "anthropic-beta": [...n ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
  archive(e, t, r) {
    let { vault_id: o, betas: n } = t;
    return this._client.post(M`/v1/vaults/${o}/credentials/${e}/archive?beta=true`, { ...r, headers: E([{ "anthropic-beta": [...n ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
};
var hi = class extends J {
  constructor() {
    super(...arguments);
    this.credentials = new za(this._client);
  }
  create(e, t) {
    let { betas: r, ...o } = e;
    return this._client.post("/v1/vaults?beta=true", { body: o, ...t, headers: E([{ "anthropic-beta": [...r ?? [], "managed-agents-2026-04-01"].toString() }, t?.headers]) });
  }
  retrieve(e, t = {}, r) {
    let { betas: o } = t ?? {};
    return this._client.get(M`/v1/vaults/${e}?beta=true`, { ...r, headers: E([{ "anthropic-beta": [...o ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
  update(e, t, r) {
    let { betas: o, ...n } = t;
    return this._client.post(M`/v1/vaults/${e}?beta=true`, { body: n, ...r, headers: E([{ "anthropic-beta": [...o ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
  list(e = {}, t) {
    let { betas: r, ...o } = e ?? {};
    return this._client.getAPIList("/v1/vaults?beta=true", ye, { query: o, ...t, headers: E([{ "anthropic-beta": [...r ?? [], "managed-agents-2026-04-01"].toString() }, t?.headers]) });
  }
  delete(e, t = {}, r) {
    let { betas: o } = t ?? {};
    return this._client.delete(M`/v1/vaults/${e}?beta=true`, { ...r, headers: E([{ "anthropic-beta": [...o ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
  archive(e, t = {}, r) {
    let { betas: o } = t ?? {};
    return this._client.post(M`/v1/vaults/${e}/archive?beta=true`, { ...r, headers: E([{ "anthropic-beta": [...o ?? [], "managed-agents-2026-04-01"].toString() }, r?.headers]) });
  }
};
hi.Credentials = za;
var it = class extends J {
  constructor() {
    super(...arguments);
    this.models = new va(this._client), this.messages = new vn(this._client), this.agents = new li(this._client), this.environments = new ya(this._client), this.sessions = new uo(this._client), this.vaults = new hi(this._client), this.memoryStores = new ao(this._client), this.files = new _a(this._client), this.skills = new gi(this._client), this.userProfiles = new Sa(this._client);
  }
};
it.Models = va;
it.Messages = vn;
it.Agents = li;
it.Environments = ya;
it.Sessions = uo;
it.Vaults = hi;
it.MemoryStores = ao;
it.Files = _a;
it.Skills = gi;
it.UserProfiles = Sa;
var yi = class extends J {
  create(e, t) {
    let { betas: r, ...o } = e;
    return this._client.post("/v1/complete", { body: o, timeout: this._client._options.timeout ?? 6e5, ...t, headers: E([{ ...r?.toString() != null ? { "anthropic-beta": r?.toString() } : void 0 }, t?.headers]), stream: e.stream ?? false });
  }
};
function tE(e) {
  return e?.output_config?.format;
}
function uh(e, t, r) {
  let o = tE(t);
  if (!t || !("parse" in (o ?? {}))) return { ...e, content: e.content.map((n) => {
    if (n.type === "text") return Object.defineProperty({ ...n }, "parsed_output", { value: null, enumerable: false });
    return n;
  }), parsed_output: null };
  return dh(e, t, r);
}
function dh(e, t, r) {
  let o = null, n = e.content.map((i) => {
    if (i.type === "text") {
      let s = xF(t, i.text);
      if (o === null) o = s;
      return Object.defineProperty({ ...i }, "parsed_output", { value: s, enumerable: false });
    }
    return i;
  });
  return { ...e, content: n, parsed_output: o };
}
function xF(e, t) {
  let r = tE(e);
  if (r?.type !== "json_schema") return null;
  try {
    if ("parse" in r) return r.parse(t);
    return JSON.parse(t);
  } catch (o) {
    throw new z(`Failed to parse structured output: ${o}`);
  }
}
var Kt;
var Sn;
var bi;
var La;
var ed;
var Fa;
var Ha;
var td;
var Ba;
var Lr;
var qa;
var rd;
var nd;
var po;
var od;
var id;
var Va;
var ph;
var rE;
var fh;
var mh;
var gh;
var hh;
var nE;
var oE = "__json_buf";
function iE(e) {
  return e.type === "tool_use" || e.type === "server_tool_use";
}
var Za = class _Za {
  constructor(e, t) {
    Kt.add(this), this.messages = [], this.receivedMessages = [], Sn.set(this, void 0), bi.set(this, null), this.controller = new AbortController(), La.set(this, void 0), ed.set(this, () => {
    }), Fa.set(this, () => {
    }), Ha.set(this, void 0), td.set(this, () => {
    }), Ba.set(this, () => {
    }), Lr.set(this, {}), qa.set(this, false), rd.set(this, false), nd.set(this, false), po.set(this, false), od.set(this, void 0), id.set(this, void 0), Va.set(this, void 0), fh.set(this, (r) => {
      if (N(this, rd, true, "f"), Nr(r)) r = new et();
      if (r instanceof et) return N(this, nd, true, "f"), this._emit("abort", r);
      if (r instanceof z) return this._emit("error", r);
      if (r instanceof Error) {
        let o = new z(r.message);
        return o.cause = r, this._emit("error", o);
      }
      return this._emit("error", new z(String(r)));
    }), N(this, La, new Promise((r, o) => {
      N(this, ed, r, "f"), N(this, Fa, o, "f");
    }), "f"), N(this, Ha, new Promise((r, o) => {
      N(this, td, r, "f"), N(this, Ba, o, "f");
    }), "f"), _(this, La, "f").catch(() => {
    }), _(this, Ha, "f").catch(() => {
    }), N(this, bi, e, "f"), N(this, Va, t?.logger ?? console, "f");
  }
  get response() {
    return _(this, od, "f");
  }
  get request_id() {
    return _(this, id, "f");
  }
  async withResponse() {
    N(this, po, true, "f");
    let e = await _(this, La, "f");
    if (!e) throw Error("Could not resolve a `Response` object");
    return { data: this, response: e, request_id: e.headers.get("request-id") };
  }
  static fromReadableStream(e) {
    let t = new _Za(null);
    return t._run(() => t._fromReadableStream(e)), t;
  }
  static createMessage(e, t, r, { logger: o } = {}) {
    let n = new _Za(t, { logger: o });
    for (let i of t.messages) n._addMessageParam(i);
    return N(n, bi, { ...t, stream: true }, "f"), n._run(() => n._createMessage(e, { ...t, stream: true }, { ...r, headers: { ...r?.headers, "X-Stainless-Helper-Method": "stream" } })), n;
  }
  _run(e) {
    e().then(() => {
      this._emitFinal(), this._emit("end");
    }, _(this, fh, "f"));
  }
  _addMessageParam(e) {
    this.messages.push(e);
  }
  _addMessage(e, t = true) {
    if (this.receivedMessages.push(e), t) this._emit("message", e);
  }
  async _createMessage(e, t, r) {
    let o = r?.signal, n;
    if (o) {
      if (o.aborted) this.controller.abort();
      n = this.controller.abort.bind(this.controller), o.addEventListener("abort", n);
    }
    try {
      _(this, Kt, "m", mh).call(this);
      let { response: i, data: s } = await e.create({ ...t, stream: true }, { ...r, signal: this.controller.signal }).withResponse();
      this._connected(i);
      for await (let a of s) _(this, Kt, "m", gh).call(this, a);
      if (s.controller.signal?.aborted) throw new et();
      _(this, Kt, "m", hh).call(this);
    } finally {
      if (o && n) o.removeEventListener("abort", n);
    }
  }
  _connected(e) {
    if (this.ended) return;
    N(this, od, e, "f"), N(this, id, e?.headers.get("request-id"), "f"), _(this, ed, "f").call(this, e), this._emit("connect");
  }
  get ended() {
    return _(this, qa, "f");
  }
  get errored() {
    return _(this, rd, "f");
  }
  get aborted() {
    return _(this, nd, "f");
  }
  abort() {
    this.controller.abort();
  }
  on(e, t) {
    return (_(this, Lr, "f")[e] || (_(this, Lr, "f")[e] = [])).push({ listener: t }), this;
  }
  off(e, t) {
    let r = _(this, Lr, "f")[e];
    if (!r) return this;
    let o = r.findIndex((n) => n.listener === t);
    if (o >= 0) r.splice(o, 1);
    return this;
  }
  once(e, t) {
    return (_(this, Lr, "f")[e] || (_(this, Lr, "f")[e] = [])).push({ listener: t, once: true }), this;
  }
  emitted(e) {
    return new Promise((t, r) => {
      if (N(this, po, true, "f"), e !== "error") this.once("error", r);
      this.once(e, t);
    });
  }
  async done() {
    N(this, po, true, "f"), await _(this, Ha, "f");
  }
  get currentMessage() {
    return _(this, Sn, "f");
  }
  async finalMessage() {
    return await this.done(), _(this, Kt, "m", ph).call(this);
  }
  async finalText() {
    return await this.done(), _(this, Kt, "m", rE).call(this);
  }
  _emit(e, ...t) {
    if (_(this, qa, "f")) return;
    if (e === "end") N(this, qa, true, "f"), _(this, td, "f").call(this);
    let r = _(this, Lr, "f")[e];
    if (r) _(this, Lr, "f")[e] = r.filter((o) => !o.once), r.forEach(({ listener: o }) => o(...t));
    if (e === "abort") {
      let o = t[0];
      if (!_(this, po, "f") && !r?.length) Promise.reject(o);
      _(this, Fa, "f").call(this, o), _(this, Ba, "f").call(this, o), this._emit("end");
      return;
    }
    if (e === "error") {
      let o = t[0];
      if (!_(this, po, "f") && !r?.length) Promise.reject(o);
      _(this, Fa, "f").call(this, o), _(this, Ba, "f").call(this, o), this._emit("end");
    }
  }
  _emitFinal() {
    if (this.receivedMessages.at(-1)) this._emit("finalMessage", _(this, Kt, "m", ph).call(this));
  }
  async _fromReadableStream(e, t) {
    let r = t?.signal, o;
    if (r) {
      if (r.aborted) this.controller.abort();
      o = this.controller.abort.bind(this.controller), r.addEventListener("abort", o);
    }
    try {
      _(this, Kt, "m", mh).call(this), this._connected(null);
      let n = Dt.fromReadableStream(e, this.controller);
      for await (let i of n) _(this, Kt, "m", gh).call(this, i);
      if (n.controller.signal?.aborted) throw new et();
      _(this, Kt, "m", hh).call(this);
    } finally {
      if (r && o) r.removeEventListener("abort", o);
    }
  }
  [(Sn = /* @__PURE__ */ new WeakMap(), bi = /* @__PURE__ */ new WeakMap(), La = /* @__PURE__ */ new WeakMap(), ed = /* @__PURE__ */ new WeakMap(), Fa = /* @__PURE__ */ new WeakMap(), Ha = /* @__PURE__ */ new WeakMap(), td = /* @__PURE__ */ new WeakMap(), Ba = /* @__PURE__ */ new WeakMap(), Lr = /* @__PURE__ */ new WeakMap(), qa = /* @__PURE__ */ new WeakMap(), rd = /* @__PURE__ */ new WeakMap(), nd = /* @__PURE__ */ new WeakMap(), po = /* @__PURE__ */ new WeakMap(), od = /* @__PURE__ */ new WeakMap(), id = /* @__PURE__ */ new WeakMap(), Va = /* @__PURE__ */ new WeakMap(), fh = /* @__PURE__ */ new WeakMap(), Kt = /* @__PURE__ */ new WeakSet(), ph = function() {
    if (this.receivedMessages.length === 0) throw new z("stream ended without producing a Message with role=assistant");
    return this.receivedMessages.at(-1);
  }, rE = function() {
    if (this.receivedMessages.length === 0) throw new z("stream ended without producing a Message with role=assistant");
    let t = this.receivedMessages.at(-1).content.filter((r) => r.type === "text").map((r) => r.text);
    if (t.length === 0) throw new z("stream ended without producing a content block with type=text");
    return t.join(" ");
  }, mh = function() {
    if (this.ended) return;
    N(this, Sn, void 0, "f");
  }, gh = function(t) {
    if (this.ended) return;
    let r = _(this, Kt, "m", nE).call(this, t);
    switch (this._emit("streamEvent", t, r), t.type) {
      case "content_block_delta": {
        let o = r.content.at(-1);
        switch (t.delta.type) {
          case "text_delta": {
            if (o.type === "text") this._emit("text", t.delta.text, o.text || "");
            break;
          }
          case "citations_delta": {
            if (o.type === "text") this._emit("citation", t.delta.citation, o.citations ?? []);
            break;
          }
          case "input_json_delta": {
            if (iE(o) && o.input) this._emit("inputJson", t.delta.partial_json, o.input);
            break;
          }
          case "thinking_delta": {
            if (o.type === "thinking") this._emit("thinking", t.delta.thinking, o.thinking);
            break;
          }
          case "signature_delta": {
            if (o.type === "thinking") this._emit("signature", o.signature);
            break;
          }
          default:
            sE(t.delta);
        }
        break;
      }
      case "message_stop": {
        this._addMessageParam(r), this._addMessage(uh(r, _(this, bi, "f"), { logger: _(this, Va, "f") }), true);
        break;
      }
      case "content_block_stop": {
        this._emit("contentBlock", r.content.at(-1));
        break;
      }
      case "message_start": {
        N(this, Sn, r, "f");
        break;
      }
      case "content_block_start":
      case "message_delta":
        break;
    }
  }, hh = function() {
    if (this.ended) throw new z("stream has ended, this shouldn't happen");
    let t = _(this, Sn, "f");
    if (!t) throw new z("request ended without sending any chunks");
    return N(this, Sn, void 0, "f"), uh(t, _(this, bi, "f"), { logger: _(this, Va, "f") });
  }, nE = function(t) {
    let r = _(this, Sn, "f");
    if (t.type === "message_start") {
      if (r) throw new z(`Unexpected event order, got ${t.type} before receiving "message_stop"`);
      return t.message;
    }
    if (!r) throw new z(`Unexpected event order, got ${t.type} before "message_start"`);
    switch (t.type) {
      case "message_stop":
        return r;
      case "message_delta":
        if (r.stop_reason = t.delta.stop_reason, r.stop_sequence = t.delta.stop_sequence, r.usage.output_tokens = t.usage.output_tokens, t.usage.input_tokens != null) r.usage.input_tokens = t.usage.input_tokens;
        if (t.usage.cache_creation_input_tokens != null) r.usage.cache_creation_input_tokens = t.usage.cache_creation_input_tokens;
        if (t.usage.cache_read_input_tokens != null) r.usage.cache_read_input_tokens = t.usage.cache_read_input_tokens;
        if (t.usage.server_tool_use != null) r.usage.server_tool_use = t.usage.server_tool_use;
        return r;
      case "content_block_start":
        return r.content.push({ ...t.content_block }), r;
      case "content_block_delta": {
        let o = r.content.at(t.index);
        switch (t.delta.type) {
          case "text_delta": {
            if (o?.type === "text") r.content[t.index] = { ...o, text: (o.text || "") + t.delta.text };
            break;
          }
          case "citations_delta": {
            if (o?.type === "text") r.content[t.index] = { ...o, citations: [...o.citations ?? [], t.delta.citation] };
            break;
          }
          case "input_json_delta": {
            if (o && iE(o)) {
              let n = o[oE] || "";
              n += t.delta.partial_json;
              let i = { ...o };
              if (Object.defineProperty(i, oE, { value: n, enumerable: false, writable: true }), n) i.input = Zu(n);
              r.content[t.index] = i;
            }
            break;
          }
          case "thinking_delta": {
            if (o?.type === "thinking") r.content[t.index] = { ...o, thinking: o.thinking + t.delta.thinking };
            break;
          }
          case "signature_delta": {
            if (o?.type === "thinking") r.content[t.index] = { ...o, signature: t.delta.signature };
            break;
          }
          default:
            sE(t.delta);
        }
        return r;
      }
      case "content_block_stop":
        return r;
    }
  }, Symbol.asyncIterator)]() {
    let e = [], t = [], r = false;
    return this.on("streamEvent", (o) => {
      let n = t.shift();
      if (n) n.resolve(o);
      else e.push(o);
    }), this.on("end", () => {
      r = true;
      for (let o of t) o.resolve(void 0);
      t.length = 0;
    }), this.on("abort", (o) => {
      r = true;
      for (let n of t) n.reject(o);
      t.length = 0;
    }), this.on("error", (o) => {
      r = true;
      for (let n of t) n.reject(o);
      t.length = 0;
    }), { next: async () => {
      if (!e.length) {
        if (r) return { value: void 0, done: true };
        return new Promise((n, i) => t.push({ resolve: n, reject: i })).then((n) => n ? { value: n, done: false } : { value: void 0, done: true });
      }
      return { value: e.shift(), done: false };
    }, return: async () => (this.abort(), { value: void 0, done: true }) };
  }
  toReadableStream() {
    return new Dt(this[Symbol.asyncIterator].bind(this), this.controller).toReadableStream();
  }
};
function sE(e) {
}
var Wa = class extends J {
  create(e, t) {
    return this._client.post("/v1/messages/batches", { body: e, ...t });
  }
  retrieve(e, t) {
    return this._client.get(M`/v1/messages/batches/${e}`, t);
  }
  list(e = {}, t) {
    return this._client.getAPIList("/v1/messages/batches", ar, { query: e, ...t });
  }
  delete(e, t) {
    return this._client.delete(M`/v1/messages/batches/${e}`, t);
  }
  cancel(e, t) {
    return this._client.post(M`/v1/messages/batches/${e}/cancel`, t);
  }
  async results(e, t) {
    let r = await this.retrieve(e);
    if (!r.results_url) throw new z(`No batch \`results_url\`; Has it finished processing? ${r.processing_status} - ${r.id}`);
    return this._client.get(r.results_url, { ...t, headers: E([{ Accept: "application/binary" }, t?.headers]), stream: true, __binaryResponse: true })._thenUnwrap((o, n) => ui.fromResponse(n.response, n.controller));
  }
};
var fo = class extends J {
  constructor() {
    super(...arguments);
    this.batches = new Wa(this._client);
  }
  create(e, t) {
    if (e.model in aE) console.warn(`The model '${e.model}' is deprecated and will reach end-of-life on ${aE[e.model]}
Please migrate to a newer model. Visit https://docs.anthropic.com/en/docs/resources/model-deprecations for more information.`);
    if (kF.includes(e.model) && e.thinking && e.thinking.type === "enabled") console.warn(`Using Claude with ${e.model} and 'thinking.type=enabled' is deprecated. Use 'thinking.type=adaptive' instead which results in better model performance in our testing: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking`);
    let r = this._client._options.timeout;
    if (!e.stream && r == null) {
      let n = Vu[e.model] ?? void 0;
      r = this._client.calculateNonstreamingTimeout(e.max_tokens, n);
    }
    let o = qu(e.tools, e.messages);
    return this._client.post("/v1/messages", { body: e, timeout: r ?? 6e5, ...t, headers: E([o, t?.headers]), stream: e.stream ?? false });
  }
  parse(e, t) {
    return this.create(e, t).then((r) => dh(r, e, { logger: this._client.logger ?? console }));
  }
  stream(e, t) {
    return Za.createMessage(this, e, t, { logger: this._client.logger ?? console });
  }
  countTokens(e, t) {
    return this._client.post("/v1/messages/count_tokens", { body: e, ...t });
  }
};
var aE = { "claude-1.3": "November 6th, 2024", "claude-1.3-100k": "November 6th, 2024", "claude-instant-1.1": "November 6th, 2024", "claude-instant-1.1-100k": "November 6th, 2024", "claude-instant-1.2": "November 6th, 2024", "claude-3-sonnet-20240229": "July 21st, 2025", "claude-3-opus-20240229": "January 5th, 2026", "claude-2.1": "July 21st, 2025", "claude-2.0": "July 21st, 2025", "claude-3-7-sonnet-latest": "February 19th, 2026", "claude-3-7-sonnet-20250219": "February 19th, 2026", "claude-3-5-haiku-latest": "February 19th, 2026", "claude-3-5-haiku-20241022": "February 19th, 2026", "claude-opus-4-0": "June 15th, 2026", "claude-opus-4-20250514": "June 15th, 2026", "claude-sonnet-4-0": "June 15th, 2026", "claude-sonnet-4-20250514": "June 15th, 2026" };
var kF = ["claude-mythos-preview", "claude-opus-4-6"];
fo.Batches = Wa;
var _i = class extends J {
  retrieve(e, t = {}, r) {
    let { betas: o } = t ?? {};
    return this._client.get(M`/v1/models/${e}`, { ...r, headers: E([{ ...o?.toString() != null ? { "anthropic-beta": o?.toString() } : void 0 }, r?.headers]) });
  }
  list(e = {}, t) {
    let { betas: r, ...o } = e ?? {};
    return this._client.getAPIList("/v1/models", ar, { query: o, ...t, headers: E([{ ...r?.toString() != null ? { "anthropic-beta": r?.toString() } : void 0 }, t?.headers]) });
  }
};
var yh;
var bh;
var sd;
var cE;
var lE = "\\n\\nHuman:";
var uE = "\\n\\nAssistant:";
var Ue = class {
  get credentials() {
    return this._authState.provider;
  }
  constructor({ baseURL: e = ge("ANTHROPIC_BASE_URL"), apiKey: t, authToken: r, ...o } = {}) {
    if (yh.add(this), this._requestAuthFlags = /* @__PURE__ */ new WeakMap(), sd.set(this, void 0), t === void 0) t = o.profile != null ? null : ge("ANTHROPIC_API_KEY") ?? null;
    if (r === void 0) r = o.profile != null ? null : ge("ANTHROPIC_AUTH_TOKEN") ?? null;
    if (o.profile != null && (o.credentials != null || o.config != null)) throw TypeError("Pass at most one of `profile`, `credentials`, or `config`.");
    let n = { apiKey: t, authToken: r, ...o, baseURL: e || "https://api.anthropic.com" };
    if (!n.dangerouslyAllowBrowser && pk()) throw new z(`It looks like you're running in a browser-like environment.

This is disabled by default, as it risks exposing your secret API credentials to attackers.
If you understand the risks and have appropriate mitigations in place,
you can set the \`dangerouslyAllowBrowser\` option to \`true\`, e.g.,

new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
`);
    this.baseURL = n.baseURL, this._baseURLIsExplicit = o.__baseURLIsExplicit ?? !!e, this.timeout = n.timeout ?? bh.DEFAULT_TIMEOUT, this.logger = n.logger ?? console;
    let i = "warn";
    this.logLevel = i, this.logLevel = Zg(n.logLevel, "ClientOptions.logLevel", this) ?? Zg(ge("ANTHROPIC_LOG"), "process.env['ANTHROPIC_LOG']", this) ?? i, this.fetchOptions = n.fetchOptions, this.maxRetries = n.maxRetries ?? 2, this.fetch = n.fetch ?? fk(), N(this, sd, gk, "f");
    let s = ge("ANTHROPIC_CUSTOM_HEADERS");
    if (s) {
      let c = {};
      for (let u of s.split(`
`)) {
        let d = u.indexOf(":");
        if (d >= 0) c[u.substring(0, d).trim()] = u.substring(d + 1).trim();
      }
      n.defaultHeaders = { ...c, ...n.defaultHeaders };
    }
    let a = o.__auth;
    if (delete n.__auth, delete n.__baseURLIsExplicit, this._options = n, this.apiKey = typeof t === "string" ? t : null, this.authToken = r, a) {
      if (this._authState = a, !this._baseURLIsExplicit && a.baseURL) this.baseURL = a.baseURL;
    } else if (this._authState = { provider: null, tokenCache: null, resolution: null, error: null, extraHeaders: {} }, this.apiKey == null && this.authToken == null) {
      let c = n.credentials ?? null;
      if (c) this._authState.provider = c, this._authState.tokenCache = this._makeTokenCache(c);
      else if (n.config != null) {
        let u = Gg(n.config, this._credentialResolverOptions());
        this._authState.provider = u.provider, this._authState.tokenCache = this._makeTokenCache(u.provider), this._authState.extraHeaders = u.extraHeaders, this._applyCredentialBaseURL(u.baseURL);
      } else if (n.profile != null) this._authState.resolution = this._resolveDefaultCredentials(n.profile);
      else this._authState.resolution = this._resolveDefaultCredentials();
    }
  }
  _applyCredentialBaseURL(e) {
    if (!e) return;
    let t = e.replace(/\/+$/, "");
    if (this._authState.baseURL = t, !this._baseURLIsExplicit) this.baseURL = t;
  }
  _credentialResolverOptions() {
    return { baseURL: this.baseURL, fetch: this.fetch, userAgent: this.getUserAgent(), onCacheWriteError: (e) => {
      Fe(this).debug("credential cache write failed (best-effort)", e);
    }, onSafetyWarning: (e) => {
      Fe(this).warn(e);
    } };
  }
  _makeTokenCache(e) {
    return new qg(e, (t) => {
      Fe(this).debug("advisory token refresh failed; serving cached token", t);
    });
  }
  withOptions(e) {
    let t = "credentials" in e || "config" in e || "profile" in e, r = "apiKey" in e || "authToken" in e || t, o = { ...this._options, ...this._baseURLIsExplicit ? { baseURL: this.baseURL } : {}, maxRetries: this.maxRetries, timeout: this.timeout, logger: this.logger, logLevel: this.logLevel, fetch: this.fetch, fetchOptions: this.fetchOptions, apiKey: this.apiKey, authToken: this.authToken, credentials: this.credentials, ...t ? { credentials: void 0, config: void 0, profile: void 0 } : {}, ...e, __auth: r ? void 0 : this._authState, __baseURLIsExplicit: "baseURL" in e ? true : this._baseURLIsExplicit };
    return new this.constructor(o);
  }
  async _resolveDefaultCredentials(e) {
    try {
      let t = await Mk(this._credentialResolverOptions(), e);
      if (t) this._authState.provider = t.provider, this._authState.tokenCache = this._makeTokenCache(t.provider), this._authState.extraHeaders = t.extraHeaders, this._applyCredentialBaseURL(t.baseURL);
      else if (e != null) throw new z(`Profile "${e}" could not be resolved (no <config_dir>/configs/${e}.json found).`);
    } catch (t) {
      this._authState.error = t;
    } finally {
      this._authState.resolution = null;
    }
  }
  defaultQuery() {
    return this._options.defaultQuery;
  }
  validateHeaders({ values: e, nulls: t }) {
    if (e.get("x-api-key") || e.get("authorization")) return;
    if (this._authState.error) throw this._authState.error;
    if (this._authState.tokenCache || this._authState.resolution) return;
    if (this.apiKey && e.get("x-api-key")) return;
    if (t.has("x-api-key")) return;
    if (this.authToken && e.get("authorization")) return;
    if (t.has("authorization")) return;
    throw Error('Could not resolve authentication method. Expected one of apiKey, authToken, credentials, config, or profile to be set. Or for one of the "X-Api-Key" or "Authorization" headers to be explicitly omitted');
  }
  _authFlags(e) {
    let t = this._requestAuthFlags.get(e);
    if (!t) t = { usedTokenCache: false, didRefreshFor401: false }, this._requestAuthFlags.set(e, t);
    return t;
  }
  async authHeaders(e) {
    if (this._authState.resolution) await this._authState.resolution;
    if (this._authState.error) return;
    if (this._authState.tokenCache && this.apiKey == null) {
      let t = await this._authState.tokenCache.getToken();
      return this._authFlags(e).usedTokenCache = true, E([{ Authorization: `Bearer ${t}` }]);
    }
    return E([await this.apiKeyAuth(e), await this.bearerAuth(e)]);
  }
  async apiKeyAuth(e) {
    if (this.apiKey == null) return;
    return E([{ "X-Api-Key": this.apiKey }]);
  }
  async bearerAuth(e) {
    if (this.authToken == null) return;
    return E([{ Authorization: `Bearer ${this.authToken}` }]);
  }
  stringifyQuery(e) {
    return hk(e);
  }
  getUserAgent() {
    return `${this.constructor.name}/JS ${Zt}`;
  }
  defaultIdempotencyKey() {
    return `stainless-node-retry-${Ug()}`;
  }
  makeStatusError(e, t, r, o) {
    return Ke.generate(e, t, r, o);
  }
  buildURL(e, t, r) {
    let o = !_(this, yh, "m", cE).call(this) && r || this.baseURL, n = ik(e) ? new URL(e) : new URL(o + (o.endsWith("/") && e.startsWith("/") ? e.slice(1) : e)), i = this.defaultQuery(), s = Object.fromEntries(n.searchParams);
    if (!Fg(i) || !Fg(s)) t = { ...s, ...i, ...t };
    if (typeof t === "object" && t && !Array.isArray(t)) n.search = this.stringifyQuery(t);
    return n.toString();
  }
  _calculateNonstreamingTimeout(e) {
    if (3600 * e / 128e3 > 600) throw new z("Streaming is required for operations that may take longer than 10 minutes. See https://github.com/anthropics/anthropic-sdk-typescript#streaming-responses for more details");
    return 6e5;
  }
  async prepareOptions(e) {
  }
  async prepareRequest(e, { url: t, options: r }) {
    if (this._authState.tokenCache && this.apiKey == null) {
      let o = e.headers instanceof Headers ? e.headers : new Headers(e.headers);
      for (let [i, s] of Object.entries(this._authState.extraHeaders)) if (!o.has(i)) o.set(i, s);
      if (!o.get("anthropic-beta")?.split(",").map((i) => i.trim())?.includes(oo)) o.append("anthropic-beta", oo);
      e.headers = o;
    }
  }
  get(e, t) {
    return this.methodRequest("get", e, t);
  }
  post(e, t) {
    return this.methodRequest("post", e, t);
  }
  patch(e, t) {
    return this.methodRequest("patch", e, t);
  }
  put(e, t) {
    return this.methodRequest("put", e, t);
  }
  delete(e, t) {
    return this.methodRequest("delete", e, t);
  }
  methodRequest(e, t, r) {
    return this.request(Promise.resolve(r).then((o) => ({ method: e, path: t, ...o })));
  }
  request(e, t = null) {
    return new io(this, this.makeRequest(e, t, void 0));
  }
  async makeRequest(e, t, r) {
    let o = await e, n = o.maxRetries ?? this.maxRetries;
    if (t == null) t = n, this._requestAuthFlags.delete(o);
    await this.prepareOptions(o);
    let { req: i, url: s, timeout: a } = await this.buildRequest(o, { retryCount: n - t });
    await this.prepareRequest(i, { url: s, options: o });
    let c = "log_" + (Math.random() * 16777216 | 0).toString(16).padStart(6, "0"), u = r === void 0 ? "" : `, retryOf: ${r}`, d = Date.now();
    if (Fe(this).debug(`[${c}] sending request`, jr({ retryOfRequestLogID: r, method: o.method, url: s, options: o, headers: i.headers })), o.signal?.aborted) throw new et();
    let p = new AbortController(), f = await this.fetchWithTimeout(s, i, a, p).catch(ta), m = Date.now();
    if (f instanceof globalThis.Error) {
      let y = `retrying, ${t} attempts remaining`;
      if (o.signal?.aborted) throw new et();
      let v = Nr(f) || /timed? ?out/i.test(String(f) + ("cause" in f ? String(f.cause) : ""));
      if (t) return Fe(this).info(`[${c}] connection ${v ? "timed out" : "failed"} - ${y}`), Fe(this).debug(`[${c}] connection ${v ? "timed out" : "failed"} (${y})`, jr({ retryOfRequestLogID: r, url: s, durationMs: m - d, message: f.message })), this.retryRequest(o, t, r ?? c);
      if (Fe(this).info(`[${c}] connection ${v ? "timed out" : "failed"} - error; no more retries left`), Fe(this).debug(`[${c}] connection ${v ? "timed out" : "failed"} (error; no more retries left)`, jr({ retryOfRequestLogID: r, url: s, durationMs: m - d, message: f.message })), v) throw new ra();
      throw new no({ cause: f });
    }
    let g = [...f.headers.entries()].filter(([y]) => y === "request-id").map(([y, v]) => ", " + y + ": " + JSON.stringify(v)).join(""), h = `[${c}${u}${g}] ${i.method} ${s} ${f.ok ? "succeeded" : "failed"} with status ${f.status} in ${m - d}ms`;
    if (!f.ok) {
      let y = await this.shouldRetry(f, o);
      if (t && y) {
        let se = `retrying, ${t} attempts remaining`;
        return await mk(f.body), Fe(this).info(`${h} - ${se}`), Fe(this).debug(`[${c}] response error (${se})`, jr({ retryOfRequestLogID: r, url: f.url, status: f.status, headers: f.headers, durationMs: m - d })), this.retryRequest(o, t, r ?? c, f.headers);
      }
      let v = y ? "error; no more retries left" : "error; not retryable";
      Fe(this).info(`${h} - ${v}`);
      let w = await f.text().catch((se) => ta(se).message), x = Ru(w), $ = x ? void 0 : w;
      throw Fe(this).debug(`[${c}] response error (${v})`, jr({ retryOfRequestLogID: r, url: f.url, status: f.status, headers: f.headers, message: $, durationMs: Date.now() - d })), this.makeStatusError(f.status, x, $, f.headers);
    }
    return Fe(this).info(h), Fe(this).debug(`[${c}] response start`, jr({ retryOfRequestLogID: r, url: f.url, status: f.status, headers: f.headers, durationMs: m - d })), { response: f, options: o, controller: p, requestLogID: c, retryOfRequestLogID: r, startTime: d };
  }
  getAPIList(e, t, r) {
    return this.requestAPIList(t, r && "then" in r ? r.then((o) => ({ method: "get", path: e, ...o })) : { method: "get", path: e, ...r });
  }
  requestAPIList(e, t) {
    let r = this.makeRequest(t, null, void 0);
    return new Fu(this, r, e);
  }
  async fetchWithTimeout(e, t, r, o) {
    let { signal: n, method: i, ...s } = t || {}, a = this._makeAbort(o);
    if (n) n.addEventListener("abort", a, { once: true });
    let c = setTimeout(a, r), u = globalThis.ReadableStream && s.body instanceof globalThis.ReadableStream || typeof s.body === "object" && s.body !== null && Symbol.asyncIterator in s.body, d = { signal: o.signal, ...u ? { duplex: "half" } : {}, method: "GET", ...s };
    if (i) d.method = i.toUpperCase();
    try {
      return await this.fetch.call(void 0, e, d);
    } finally {
      clearTimeout(c);
    }
  }
  async shouldRetry(e, t) {
    let r = this._authFlags(t);
    if (e.status === 401 && this._authState.tokenCache && r.usedTokenCache && !r.didRefreshFor401) return r.didRefreshFor401 = true, this._authState.tokenCache.invalidate(), true;
    let o = e.headers.get("x-should-retry");
    if (o === "true") return true;
    if (o === "false") return false;
    if (e.status === 408) return true;
    if (e.status === 409) return true;
    if (e.status === 429) return true;
    if (e.status >= 500) return true;
    return false;
  }
  async retryRequest(e, t, r, o) {
    let n, i = o?.get("retry-after-ms");
    if (i) {
      let a = parseFloat(i);
      if (!Number.isNaN(a)) n = a;
    }
    let s = o?.get("retry-after");
    if (s && !n) {
      let a = parseFloat(s);
      if (!Number.isNaN(a)) n = a * 1e3;
      else n = Date.parse(s) - Date.now();
    }
    if (n === void 0) {
      let a = e.maxRetries ?? this.maxRetries;
      n = this.calculateDefaultRetryTimeoutMillis(t, a);
    }
    return await ck(n), this.makeRequest(e, t - 1, r);
  }
  calculateDefaultRetryTimeoutMillis(e, t) {
    let n = t - e, i = Math.min(0.5 * Math.pow(2, n), 8), s = 1 - Math.random() * 0.25;
    return i * s * 1e3;
  }
  calculateNonstreamingTimeout(e, t) {
    if (36e5 * e / 128e3 > 6e5 || t != null && e > t) throw new z("Streaming is required for operations that may take longer than 10 minutes. See https://github.com/anthropics/anthropic-sdk-typescript#long-requests for more details");
    return 6e5;
  }
  async buildRequest(e, { retryCount: t = 0 } = {}) {
    let r = { ...e }, { method: o, path: n, query: i, defaultBaseURL: s } = r;
    if (this._authState.resolution) await this._authState.resolution;
    if (!this._baseURLIsExplicit && this._authState.baseURL && this.baseURL !== this._authState.baseURL) this.baseURL = this._authState.baseURL;
    let a = this.buildURL(n, i, s);
    if ("timeout" in r) ak("timeout", r.timeout);
    r.timeout = r.timeout ?? this.timeout;
    let { bodyHeaders: c, body: u } = this.buildBody({ options: r }), d = await this.buildHeaders({ options: e, method: o, bodyHeaders: c, retryCount: t });
    return { req: { method: o, headers: d, ...r.signal && { signal: r.signal }, ...globalThis.ReadableStream && u instanceof globalThis.ReadableStream && { duplex: "half" }, ...u && { body: u }, ...this.fetchOptions ?? {}, ...r.fetchOptions ?? {} }, url: a, timeout: r.timeout };
  }
  async buildHeaders({ options: e, method: t, bodyHeaders: r, retryCount: o }) {
    let n = {};
    if (this.idempotencyHeader && t !== "get") {
      if (!e.idempotencyKey) e.idempotencyKey = this.defaultIdempotencyKey();
      n[this.idempotencyHeader] = e.idempotencyKey;
    }
    let i = E([n, { Accept: "application/json", "User-Agent": this.getUserAgent(), "X-Stainless-Retry-Count": String(o), ...e.timeout ? { "X-Stainless-Timeout": String(Math.trunc(e.timeout / 1e3)) } : {}, ...da(), ...this._options.dangerouslyAllowBrowser ? { "anthropic-dangerous-direct-browser-access": "true" } : void 0, "anthropic-version": "2023-06-01" }, await this.authHeaders(e), this._options.defaultHeaders, r, e.headers]);
    return this.validateHeaders(i), i.values;
  }
  _makeAbort(e) {
    return () => e.abort();
  }
  buildBody({ options: { body: e, headers: t } }) {
    if (!e) return { bodyHeaders: void 0, body: void 0 };
    let r = E([t]);
    if (ArrayBuffer.isView(e) || e instanceof ArrayBuffer || e instanceof DataView || typeof e === "string" && r.values.has("content-type") || globalThis.Blob && e instanceof globalThis.Blob || e instanceof FormData || e instanceof URLSearchParams || globalThis.ReadableStream && e instanceof globalThis.ReadableStream) return { bodyHeaders: void 0, body: e };
    else if (typeof e === "object" && (Symbol.asyncIterator in e || Symbol.iterator in e && "next" in e && typeof e.next === "function")) return { bodyHeaders: void 0, body: $u(e) };
    else if (typeof e === "object" && r.values.get("content-type") === "application/x-www-form-urlencoded") return { bodyHeaders: { "content-type": "application/x-www-form-urlencoded" }, body: this.stringifyQuery(e) };
    else return _(this, sd, "f").call(this, { body: e, headers: r });
  }
};
bh = Ue, sd = /* @__PURE__ */ new WeakMap(), yh = /* @__PURE__ */ new WeakSet(), cE = function() {
  return this.baseURL !== "https://api.anthropic.com";
};
Ue.Anthropic = bh;
Ue.HUMAN_PROMPT = lE;
Ue.AI_PROMPT = uE;
Ue.DEFAULT_TIMEOUT = 6e5;
Ue.AnthropicError = z;
Ue.APIError = Ke;
Ue.APIConnectionError = no;
Ue.APIConnectionTimeoutError = ra;
Ue.APIUserAbortError = et;
Ue.NotFoundError = sa;
Ue.ConflictError = aa;
Ue.RateLimitError = la;
Ue.BadRequestError = na;
Ue.AuthenticationError = oa;
Ue.InternalServerError = ua;
Ue.PermissionDeniedError = ia;
Ue.UnprocessableEntityError = ca;
Ue.toFile = Hu;
var mo = class extends Ue {
  constructor() {
    super(...arguments);
    this.completions = new yi(this), this.messages = new fo(this), this.models = new _i(this), this.beta = new it(this);
  }
};
mo.Completions = yi;
mo.Messages = fo;
mo.Models = _i;
mo.Beta = it;
function PF(e) {
  return e;
}
function vi(e) {
  return PF(e);
}
var dE = (e, t) => e !== null && typeof e === "object" && !("telemetryMessage" in e) ? Object.assign(e, { telemetryMessage: t }) : e;
function Pr(e) {
  return e instanceof Error ? e : Error(String(e));
}
function Si(e) {
  return e instanceof Error ? e.message : String(e);
}
function Ve(e) {
  if (e && typeof e === "object" && "code" in e && typeof e.code === "string") return e.code;
  return;
}
function Fr(e) {
  return Ve(e) === "ENOENT";
}
function _h(e) {
  return Ve(e) === "EISDIR";
}
function pE(e) {
  let t = Ve(e);
  return t === "ENOENT" || t === "EACCES" || t === "EPERM" || t === "ENOTDIR" || t === "ELOOP" || t === "ENAMETOOLONG" || t === "EROFS";
}
var OF = /* @__PURE__ */ new Set(["EXDEV", "EPERM", "EEXIST", "EBUSY"]);
var CF = /* @__PURE__ */ new Set(["EPERM", "EBUSY", "EACCES"]);
var MF = 4;
var DF = 50;
var Yde = new Int32Array(new SharedArrayBuffer(4));
function NF(e, t) {
  if (process.platform !== "win32") return false;
  let r = Ve(e);
  return r !== void 0 && CF.has(r) && t < MF - 1;
}
async function jF(e, t, r = $F) {
  let o = false;
  for (let n = 0; ; n++) try {
    return await r(e, t), o;
  } catch (i) {
    if (NF(i, n)) {
      o = true, await un(DF);
      continue;
    }
    throw i;
  }
}
var UF = /* @__PURE__ */ new Set(["ENOSPC", "EIO", "EDQUOT", "EFBIG"]);
async function fE(e, t, r) {
  let o = `${e}.tmp.${TF(4).toString("hex")}`;
  try {
    await AF(o, t, { encoding: "utf8", mode: r });
    try {
      await jF(o, e);
    } catch (n) {
      let i = Ve(n);
      if (i !== void 0 && OF.has(i)) {
        try {
          if (await RF(o, e), r !== void 0) await IF(e, r).catch(() => {
          });
        } catch (s) {
          if (UF.has(Ve(s) ?? "")) await vh(e).catch(() => {
          });
          throw s;
        }
        await vh(o).catch(() => {
        });
      } else throw n;
    }
  } catch (n) {
    throw await vh(o).catch(() => {
    }), n;
  }
}
var bE = class {
  read(e) {
    return hE(e, "utf8");
  }
  readBytes(e) {
    return hE(e);
  }
  write(e, t, r) {
    return Sh(e, t, { encoding: "utf8", mode: r });
  }
  async mkdir(e) {
    try {
      await HF(e, { recursive: true });
    } catch (t) {
      if (Ve(t) !== "EEXIST") throw t;
    }
  }
  atomicWrite(e, t, r) {
    return fE(e, t, r);
  }
  delete(e) {
    return qF(e);
  }
  list(e) {
    return gE(e);
  }
  append(e, t, r) {
    return LF(e, t, { encoding: "utf8", mode: r });
  }
  writeExclusive(e, t, r) {
    return Sh(e, t, { encoding: "utf8", flag: "wx", mode: r });
  }
  writeBytes(e, t) {
    return Sh(e, t);
  }
  copy(e, t) {
    return FF(e, t);
  }
  async stat(e) {
    return { mtimeMs: (await BF(e)).mtimeMs };
  }
  async listEntries(e) {
    return (await gE(e, { withFileTypes: true })).map((r) => ({ name: r.name, isDirectory: r.isDirectory(), isFile: r.isFile() }));
  }
  async readRange(e, t, r) {
    xh("readRange", "offset", t), xh("readRange", "length", r);
    let o = await mE(e, "r");
    try {
      return await yE(o, t, r);
    } finally {
      await o.close();
    }
  }
  async readTail(e, t) {
    xh("readTail", "maxBytes", t);
    let r = await mE(e, "r");
    try {
      let { size: o } = await r.stat(), n = Math.min(t, o);
      return await yE(r, o - n, n);
    } finally {
      await r.close();
    }
  }
};
function xh(e, t, r) {
  if (!Number.isInteger(r) || r < 0) throw RangeError(`${e}: ${t} must be a non-negative integer, got ${r}`);
}
async function yE(e, t, r) {
  if (r === 0) return Buffer.alloc(0);
  let o = Buffer.alloc(r), n = 0;
  while (n < r) {
    let { bytesRead: i } = await e.read(o, n, r - n, t + n);
    if (i === 0) break;
    n += i;
  }
  return n === r ? o : Buffer.from(o.subarray(0, n));
}
var VF = new zF();
function xi() {
  return VF.getStore() ?? new bE();
}
var go;
var wi = null;
function vE() {
  if (wi) return wi;
  if (!Ee(process.env.DEBUG_CLAUDE_AGENT_SDK)) return go = null, wi = Promise.resolve(), wi;
  let e = _E(Vt(), "debug");
  return go = _E(e, `sdk-${ZF()}.txt`), process.stderr.write(`SDK debug logs: ${go}
`), wi = xi().mkdir(e).catch(() => {
  }), wi;
}
function SE() {
  return vE(), go ?? null;
}
function xt(e) {
  if (go === null) return;
  let r = `${(/* @__PURE__ */ new Date()).toISOString()} ${e}
`;
  vE().then(() => {
    if (go) xi().append(go, r).catch(() => {
    });
  });
}
function WF() {
  this.__data__ = new gn(), this.size = 0;
}
var xE = WF;
function KF(e) {
  var t = this.__data__, r = t.delete(e);
  return this.size = t.size, r;
}
var wE = KF;
function GF(e) {
  return this.__data__.get(e);
}
var kE = GF;
function JF(e) {
  return this.__data__.has(e);
}
var EE = JF;
var XF = 200;
function YF(e, t) {
  var r = this.__data__;
  if (r instanceof gn) {
    var o = r.__data__;
    if (!Tu || o.length < XF - 1) return o.push([e, t]), this.size = ++r.size, this;
    r = this.__data__ = new ea(o);
  }
  return r.set(e, t), this.size = r.size, this;
}
var PE = YF;
function ki(e) {
  var t = this.__data__ = new gn(e);
  this.size = t.size;
}
ki.prototype.clear = xE;
ki.prototype.delete = wE;
ki.prototype.get = kE;
ki.prototype.has = EE;
ki.prototype.set = PE;
var TE = ki;
var QF = (function() {
  try {
    var e = ri(Object, "defineProperty");
    return e({}, "", {}), e;
  } catch (t) {
  }
})();
var Ei = QF;
function e4(e, t, r) {
  if (t == "__proto__" && Ei) Ei(e, t, { configurable: true, enumerable: true, value: r, writable: true });
  else e[t] = r;
}
var Pi = e4;
var t4 = Object.prototype;
var r4 = t4.hasOwnProperty;
function n4(e, t, r) {
  var o = e[t];
  if (!(r4.call(e, t) && fn(o, r)) || r === void 0 && !(t in e)) Pi(e, t, r);
}
var ad = n4;
function o4(e, t, r, o) {
  var n = !r;
  r || (r = {});
  var i = -1, s = t.length;
  while (++i < s) {
    var a = t[i], c = o ? o(r[a], e[a], a, r, e) : void 0;
    if (c === void 0) c = e[a];
    if (n) Pi(r, a, c);
    else ad(r, a, c);
  }
  return r;
}
var IE = o4;
function i4(e, t) {
  var r = -1, o = Array(e);
  while (++r < e) o[r] = t(r);
  return o;
}
var RE = i4;
function s4(e) {
  return e != null && typeof e == "object";
}
var Gt = s4;
var a4 = "[object Arguments]";
function c4(e) {
  return Gt(e) && Er(e) == a4;
}
var wh = c4;
var $E = Object.prototype;
var l4 = $E.hasOwnProperty;
var u4 = $E.propertyIsEnumerable;
var d4 = wh(/* @__PURE__ */ (function() {
  return arguments;
})()) ? wh : function(e) {
  return Gt(e) && l4.call(e, "callee") && !u4.call(e, "callee");
};
var Hr = d4;
var p4 = Array.isArray;
var pt = p4;
var ld = {};
kr(ld, { default: () => Ka });
function f4() {
  return false;
}
var AE = f4;
var ME = typeof ld == "object" && ld && !ld.nodeType && ld;
var OE = ME && typeof cd == "object" && cd && !cd.nodeType && cd;
var m4 = OE && OE.exports === ME;
var CE = m4 ? Bt.Buffer : void 0;
var g4 = CE ? CE.isBuffer : void 0;
var h4 = g4 || AE;
var Ka = h4;
var y4 = 9007199254740991;
var b4 = /^(?:0|[1-9]\d*)$/;
function _4(e, t) {
  var r = typeof e;
  return t = t == null ? y4 : t, !!t && (r == "number" || r != "symbol" && b4.test(e)) && (e > -1 && e % 1 == 0 && e < t);
}
var xn = _4;
var v4 = 9007199254740991;
function S4(e) {
  return typeof e == "number" && e > -1 && e % 1 == 0 && e <= v4;
}
var Ti = S4;
var x4 = "[object Arguments]";
var w4 = "[object Array]";
var k4 = "[object Boolean]";
var E4 = "[object Date]";
var P4 = "[object Error]";
var T4 = "[object Function]";
var I4 = "[object Map]";
var R4 = "[object Number]";
var $4 = "[object Object]";
var A4 = "[object RegExp]";
var O4 = "[object Set]";
var C4 = "[object String]";
var M4 = "[object WeakMap]";
var D4 = "[object ArrayBuffer]";
var N4 = "[object DataView]";
var j4 = "[object Float32Array]";
var U4 = "[object Float64Array]";
var z4 = "[object Int8Array]";
var L4 = "[object Int16Array]";
var F4 = "[object Int32Array]";
var H4 = "[object Uint8Array]";
var B4 = "[object Uint8ClampedArray]";
var q4 = "[object Uint16Array]";
var V4 = "[object Uint32Array]";
var $e = {};
$e[j4] = $e[U4] = $e[z4] = $e[L4] = $e[F4] = $e[H4] = $e[B4] = $e[q4] = $e[V4] = true;
$e[x4] = $e[w4] = $e[D4] = $e[k4] = $e[N4] = $e[E4] = $e[P4] = $e[T4] = $e[I4] = $e[R4] = $e[$4] = $e[A4] = $e[O4] = $e[C4] = $e[M4] = false;
function Z4(e) {
  return Gt(e) && Ti(e.length) && !!$e[Er(e)];
}
var DE = Z4;
function W4(e) {
  return function(t) {
    return e(t);
  };
}
var NE = W4;
var dd = {};
kr(dd, { default: () => pd });
var jE = typeof dd == "object" && dd && !dd.nodeType && dd;
var Ga = jE && typeof ud == "object" && ud && !ud.nodeType && ud;
var K4 = Ga && Ga.exports === jE;
var kh = K4 && Eu.process;
var G4 = (function() {
  try {
    var e = Ga && Ga.require && Ga.require("util").types;
    if (e) return e;
    return kh && kh.binding && kh.binding("util");
  } catch (t) {
  }
})();
var pd = G4;
var UE = pd && pd.isTypedArray;
var J4 = UE ? NE(UE) : DE;
var fd = J4;
var X4 = Object.prototype;
var Y4 = X4.hasOwnProperty;
function Q4(e, t) {
  var r = pt(e), o = !r && Hr(e), n = !r && !o && Ka(e), i = !r && !o && !n && fd(e), s = r || o || n || i, a = s ? RE(e.length, String) : [], c = a.length;
  for (var u in e) if ((t || Y4.call(e, u)) && !(s && (u == "length" || n && (u == "offset" || u == "parent") || i && (u == "buffer" || u == "byteLength" || u == "byteOffset") || xn(u, c)))) a.push(u);
  return a;
}
var zE = Q4;
var e2 = Object.prototype;
function t2(e) {
  var t = e && e.constructor, r = typeof t == "function" && t.prototype || e2;
  return e === r;
}
var md = t2;
function r2(e, t) {
  return function(r) {
    return e(t(r));
  };
}
var LE = r2;
function n2(e) {
  return e != null && Ti(e.length) && !ti(e);
}
var Ii = n2;
function o2(e) {
  var t = [];
  if (e != null) for (var r in Object(e)) t.push(r);
  return t;
}
var FE = o2;
var i2 = Object.prototype;
var s2 = i2.hasOwnProperty;
function a2(e) {
  if (!Qe(e)) return FE(e);
  var t = md(e), r = [];
  for (var o in e) if (!(o == "constructor" && (t || !s2.call(e, o)))) r.push(o);
  return r;
}
var HE = a2;
function c2(e) {
  return Ii(e) ? zE(e, true) : HE(e);
}
var gd = c2;
var yd = {};
kr(yd, { default: () => Eh });
var ZE = typeof yd == "object" && yd && !yd.nodeType && yd;
var BE = ZE && typeof hd == "object" && hd && !hd.nodeType && hd;
var l2 = BE && BE.exports === ZE;
var qE = l2 ? Bt.Buffer : void 0;
var VE = qE ? qE.allocUnsafe : void 0;
function u2(e, t) {
  if (t) return e.slice();
  var r = e.length, o = VE ? VE(r) : new e.constructor(r);
  return e.copy(o), o;
}
var Eh = u2;
function d2(e, t) {
  var r = -1, o = e.length;
  t || (t = Array(o));
  while (++r < o) t[r] = e[r];
  return t;
}
var WE = d2;
function p2(e, t) {
  var r = -1, o = t.length, n = e.length;
  while (++r < o) e[n + r] = t[r];
  return e;
}
var KE = p2;
var f2 = LE(Object.getPrototypeOf, Object);
var bd = f2;
var m2 = Bt.Uint8Array;
var Ph = m2;
function g2(e) {
  var t = new e.constructor(e.byteLength);
  return new Ph(t).set(new Ph(e)), t;
}
var GE = g2;
function h2(e, t) {
  var r = t ? GE(e.buffer) : e.buffer;
  return new e.constructor(r, e.byteOffset, e.length);
}
var JE = h2;
var XE = Object.create;
var y2 = /* @__PURE__ */ (function() {
  function e() {
  }
  return function(t) {
    if (!Qe(t)) return {};
    if (XE) return XE(t);
    e.prototype = t;
    var r = new e();
    return e.prototype = void 0, r;
  };
})();
var YE = y2;
function b2(e) {
  return typeof e.constructor == "function" && !md(e) ? YE(bd(e)) : {};
}
var QE = b2;
var _2 = "[object Symbol]";
function v2(e) {
  return typeof e == "symbol" || Gt(e) && Er(e) == _2;
}
var Ri = v2;
var S2 = /\.|\[(?:[^[\]]*|(["'])(?:(?!\1)[^\\]|\\.)*?\1)\]/;
var x2 = /^\w*$/;
function w2(e, t) {
  if (pt(e)) return false;
  var r = typeof e;
  if (r == "number" || r == "symbol" || r == "boolean" || e == null || Ri(e)) return true;
  return x2.test(e) || !S2.test(e) || t != null && e in Object(t);
}
var eP = w2;
var k2 = 500;
function E2(e) {
  var t = Ce(e, function(o) {
    if (r.size === k2) r.clear();
    return o;
  }), r = t.cache;
  return t;
}
var tP = E2;
var P2 = /[^.[\]]+|\[(?:(-?\d+(?:\.\d+)?)|(["'])((?:(?!\2)[^\\]|\\.)*?)\2)\]|(?=(?:\.|\[\])(?:\.|\[\]|$))/g;
var T2 = /\\(\\)?/g;
var I2 = tP(function(e) {
  var t = [];
  if (e.charCodeAt(0) === 46) t.push("");
  return e.replace(P2, function(r, o, n, i) {
    t.push(n ? i.replace(T2, "$1") : o || r);
  }), t;
});
var rP = I2;
function R2(e, t) {
  var r = -1, o = e == null ? 0 : e.length, n = Array(o);
  while (++r < o) n[r] = t(e[r], r, e);
  return n;
}
var nP = R2;
var $2 = 1 / 0;
var oP = qt ? qt.prototype : void 0;
var iP = oP ? oP.toString : void 0;
function sP(e) {
  if (typeof e == "string") return e;
  if (pt(e)) return nP(e, sP) + "";
  if (Ri(e)) return iP ? iP.call(e) : "";
  var t = e + "";
  return t == "0" && 1 / e == -$2 ? "-0" : t;
}
var aP = sP;
function A2(e) {
  return e == null ? "" : aP(e);
}
var cP = A2;
function O2(e, t) {
  if (pt(e)) return e;
  return eP(e, t) ? [e] : rP(cP(e));
}
var wn = O2;
var C2 = 1 / 0;
function M2(e) {
  if (typeof e == "string" || Ri(e)) return e;
  var t = e + "";
  return t == "0" && 1 / e == -C2 ? "-0" : t;
}
var $i = M2;
function D2(e, t) {
  t = wn(t, e);
  var r = 0, o = t.length;
  while (e != null && r < o) e = e[$i(t[r++])];
  return r && r == o ? e : void 0;
}
var lP = D2;
function N2(e, t) {
  return e != null && t in Object(e);
}
var uP = N2;
function j2(e, t, r) {
  t = wn(t, e);
  var o = -1, n = t.length, i = false;
  while (++o < n) {
    var s = $i(t[o]);
    if (!(i = e != null && r(e, s))) break;
    e = e[s];
  }
  if (i || ++o != n) return i;
  return n = e == null ? 0 : e.length, !!n && Ti(n) && xn(s, n) && (pt(e) || Hr(e));
}
var dP = j2;
function U2(e, t) {
  return e != null && dP(e, t, uP);
}
var pP = U2;
function z2(e) {
  return e;
}
var _d = z2;
var fP = "[\\w-]{1,63}";
var L2 = new RegExp(`^${fP}$`);
var Dme = new RegExp(`^a(?:${fP}-)?[0-9a-f]{16}$`);
function mP(e, t) {
  let r = Buffer.from(t.replace(/-/g, ""), "hex"), o = F2("sha1").update(r).update(Buffer.from(e, "utf8")).digest();
  o[6] = o[6] & 15 | 80, o[8] = o[8] & 63 | 128;
  let n = o.subarray(0, 16).toString("hex");
  return `${n.slice(0, 8)}-${n.slice(8, 12)}-${n.slice(12, 16)}-${n.slice(16, 20)}-${n.slice(20, 32)}`;
}
var H2 = "3ab19d7e-9f35-45c2-926e-75e271cc60b3";
function gP() {
  let e = process.env.CLAUDE_CODE_REMOTE_SESSION_ID?.trim();
  return e ? mP(e, H2) : null;
}
function wP() {
  return { sent: /* @__PURE__ */ new Set(), rejected: /* @__PURE__ */ new Set() };
}
var J2 = { renderTarget: "ink", workspace: "local", canDrive: true, transcriptSource: "local-jsonl", remote: null };
function X2() {
  let e = "";
  if (typeof process < "u" && typeof process.cwd === "function" && typeof kP === "function") {
    let r = G2();
    try {
      e = EP(kP(r));
    } catch {
      e = EP(r);
    }
  }
  return { originalCwd: e, projectRoot: e, totalCostUSD: 0, totalAPIDuration: 0, totalAPIDurationWithoutRetries: 0, totalToolDuration: 0, startTime: Date.now(), lastInteractionTime: Date.now(), totalLinesAdded: 0, totalLinesRemoved: 0, hasUnknownModelCost: false, cwd: e, modelUsage: {}, mainLoopModelOverride: void 0, refusalFallbackModelLatch: void 0, sdkDialogHostActive: false, sdkSupportedDialogKinds: void 0, sdkSupportedDialogKindsSource: void 0, replConfigArgv: [], initialMainLoopModel: void 0, resolvedOrgDefault: void 0, modelStrings: null, isInteractive: false, permissionPromptToolName: void 0, attacherCaps: null, hasStreamingInput: false, modelOverrideOptOutForSession: false, rendererMode: void 0, strictToolResultPairing: false, memoryToggledOff: false, teamMemoryServerStatus: void 0, sdkAgentProgressSummariesEnabled: false, userMsgOptIn: false, searchToolsOptIn: false, clientType: "cli", sessionSource: void 0, sessionStartType: "fresh", questionPreviewFormat: void 0, sessionIngressToken: void 0, oauthTokenFromFd: void 0, oauthScopesFromFd: void 0, apiKeyFromFd: void 0, gatewayAuth: null, gatewayRefreshInFlight: null, startupPolicySnapshot: void 0, flagSettingsPath: void 0, flagSettingsExpectedContent: void 0, flagSettingsInline: null, parentManagedSettings: null, allowedSettingSources: ["userSettings", "projectSettings", "localSettings", "flagSettings", "policySettings"], meter: null, sessionCounter: null, locCounter: null, prCounter: null, commitCounter: null, costCounter: null, tokenCounter: null, codeEditToolDecisionCounter: null, activeTimeCounter: null, statsStore: null, sessionId: gP() ?? Ja(), mainAgentId: null, parentSessionId: void 0, loggerProvider: null, eventLogger: null, pendingOTelEvents: [], meterProvider: null, tracerProvider: null, cachedTelemetryResource: null, cachedOtlpHttpAgentFactory: { direct: null, proxied: null }, foundryDeploymentCapabilities: /* @__PURE__ */ new Map(), agentColorMap: /* @__PURE__ */ new Map(), agentColorIndex: 0, lastAPIRequest: null, lastCancelledAPIMessageId: null, lastAPIRequestMessages: null, lastClassifierRequests: null, cachedClaudeMdContent: null, inMemoryErrorLog: [], inlinePlugins: [], inlinePluginsNoMcp: [], inlinePluginUrls: [], syncedPluginDirs: [], chromeFlagOverride: void 0, onboardingShownThisSession: false, useCoworkPlugins: false, disableSlashCommands: false, sessionBypassPermissionsMode: false, scheduledTasksEnabled: false, sessionPrResolved: false, sessionCronTasks: [], loopChainStartedAt: /* @__PURE__ */ Object.create(null), loopTickInFlightPrompt: null, loopConsecutiveKeepalives: 0, sessionCreatedTeams: /* @__PURE__ */ new Set(), inheritedTeamName: void 0, sessionTrustAccepted: false, sessionPersistenceDisabled: false, hasExitedPlanMode: false, needsPlanModeExitAttachment: false, needsAutoModeExitAttachment: false, lspRecommendationShownThisSession: false, initJsonSchema: null, registeredHooks: null, planSlugCache: /* @__PURE__ */ new Map(), teleportedSessionInfo: null, invokedSkills: /* @__PURE__ */ new Map(), slowOperations: [], sdkBetas: void 0, longContext1mCreditsBlocked: false, fableCreditsRequired: false, fableConsentSessionFallback: false, fableBridgeDialogTimedOut: false, fableConsentDialogInteracted: false, sdkOAuthTokenRefreshCallback: null, hostAuthTokenRefreshCallback: null, mainThreadAgentType: void 0, mainThreadAgentHooks: void 0, sessionSkillAllowlist: void 0, caps: J2, replBridgeActive: false, mainLoopBusy: false, directConnectServerUrl: void 0, mcpConnectNonBlocking: false, strictMcpConfig: false, sessionApprovedMcpServers: [], activeRoutine: void 0, systemPromptSectionCache: /* @__PURE__ */ new Map(), lastEmittedDate: null, additionalDirectoriesForClaudeMd: [], allowedChannels: [], hasDevChannels: false, sessionProjectDir: null, promptCache1hAllowlist: null, stickyBetas: wP(), thinkingTypeOverrides: /* @__PURE__ */ new Map(), inferenceProfileBackingModels: /* @__PURE__ */ new Map(), promptId: null, promptIndex: 0, lastMainRequestId: void 0, lastMainThreadCacheTtlMs: null, lastApiCompletionTimestamp: null, pendingPostCompaction: false };
}
var Y2 = X2();
var Q2 = () => {
  return;
};
function Rh() {
  return Q2()?.sessionId ?? Y2.sessionId;
}
var eH = pn();
var nge = eH.subscribe;
function EP(e) {
  return process.platform === "darwin" ? e.normalize("NFC") : e;
}
var tH = pn();
var oge = tH.subscribe;
var rH = pn();
var ige = rH.subscribe;
var nH = pn();
var sge = nH.subscribe;
var oH = pn();
var age = oH.subscribe;
function PP({ writeFn: e, flushIntervalMs: t = 1e3, maxBufferSize: r = 100, maxBufferBytes: o = 1 / 0, immediateMode: n = false }) {
  let i = [], s = 0, a = null, c = null;
  function u() {
    if (a) clearTimeout(a), a = null;
  }
  function d(g) {
    try {
      e(g);
    } catch {
    }
  }
  function p() {
    if (c) d(c.join("")), c = null;
    if (i.length === 0) return;
    d(i.join("")), i = [], s = 0, u();
  }
  function f() {
    if (!a) a = setTimeout(p, t);
  }
  function m() {
    if (c) {
      c.push(...i), i = [], s = 0, u();
      return;
    }
    let g = i;
    i = [], s = 0, u(), c = g, setImmediate(() => {
      let h = c;
      if (c = null, h) d(h.join(""));
    });
  }
  return { write(g) {
    if (n) {
      d(g);
      return;
    }
    if (i.push(g), s += g.length, f(), i.length >= r || s >= o) m();
  }, flush: p, dispose() {
    p();
  } };
}
function iH(e) {
  if (typeof e === "function") return e;
  if (Symbol.asyncDispose in e) return () => e[Symbol.asyncDispose]();
  return () => e[Symbol.dispose]();
}
var TP = class {
  #n = /* @__PURE__ */ new Set();
  register(e) {
    let t = iH(e);
    this.#n.add(t);
    let r = () => {
      this.#n.delete(t);
    };
    return Object.assign(r, { [Symbol.dispose]: r });
  }
  async drain() {
    let e = Array.from(this.#n);
    this.#n.clear(), await Promise.all(e.map(async (t) => t()));
  }
  async [Symbol.asyncDispose]() {
    await this.drain();
  }
  get sizeForTesting() {
    return this.#n.size;
  }
};
var sH = new TP();
function IP(e) {
  return sH.register(e);
}
var RP = Ce((e) => {
  if (!e || e.trim() === "") return null;
  let t = e.split(",").map((i) => i.trim()).filter(Boolean);
  if (t.length === 0) return null;
  let r = t.some((i) => i.startsWith("!")), o = t.some((i) => !i.startsWith("!"));
  if (r && o) return null;
  let n = t.map((i) => i.replace(/^!/, "").toLowerCase());
  return { include: r ? [] : n, exclude: r ? n : [], isExclusive: r };
});
function aH(e) {
  let t = [], r = e.match(/^MCP server ["']([^"']+)["']/);
  if (r && r[1]) t.push("mcp"), t.push(r[1].toLowerCase());
  else {
    let i = e.match(/^([^:[]+):/);
    if (i && i[1]) t.push(i[1].trim().toLowerCase());
  }
  let o = e.match(/^\[([^\]]+)]/);
  if (o && o[1]) t.push(o[1].trim().toLowerCase());
  if (e.toLowerCase().includes("1p event:")) t.push("1p");
  let n = e.match(/:\s*([^:]+?)(?:\s+(?:type|mode|status|event))?:/);
  if (n && n[1]) {
    let i = n[1].trim().toLowerCase();
    if (i.length < 30 && !i.includes(" ")) t.push(i);
  }
  return Array.from(new Set(t));
}
function cH(e, t) {
  if (!t) return true;
  if (e.length === 0) return false;
  if (t.isExclusive) return !e.some((r) => t.exclude.includes(r));
  else return e.some((r) => t.include.includes(r));
}
function $P(e, t) {
  if (!t) return true;
  let r = aH(e);
  return cH(r, t);
}
var Sd = "\u2192";
var _H = { cwd() {
  return process.cwd();
}, existsSync(e) {
  let r = [];
  try {
    const t = _e(r, Te`fs.existsSync(${e})`, 0);
    return Y.existsSync(e);
  } catch (o) {
    var n = o, i = 1;
  } finally {
    ve(r, n, i);
  }
}, async stat(e) {
  return hH(e);
}, async lstat(e) {
  return lH(e);
}, async readdir(e) {
  return pH(e, { withFileTypes: true });
}, async unlink(e) {
  return yH(e);
}, async rmdir(e) {
  return mH(e);
}, async rm(e, t) {
  return gH(e, t);
}, async mkdir(e, t) {
  try {
    await uH(e, { recursive: true, ...t });
  } catch (r) {
    if (Ve(r) !== "EEXIST") throw r;
  }
}, async readFile(e, t) {
  return AP(e, { encoding: t.encoding });
}, async rename(e, t) {
  return fH(e, t);
}, statSync(e) {
  let r = [];
  try {
    const t = _e(r, Te`fs.statSync(${e})`, 0);
    return Y.statSync(e);
  } catch (o) {
    var n = o, i = 1;
  } finally {
    ve(r, n, i);
  }
}, lstatSync(e) {
  let r = [];
  try {
    const t = _e(r, Te`fs.lstatSync(${e})`, 0);
    return Y.lstatSync(e);
  } catch (o) {
    var n = o, i = 1;
  } finally {
    ve(r, n, i);
  }
}, readFileSync(e, t) {
  let o = [];
  try {
    const r = _e(o, Te`fs.readFileSync(${e})`, 0);
    return Y.readFileSync(e, { encoding: t.encoding });
  } catch (n) {
    var i = n, s = 1;
  } finally {
    ve(o, i, s);
  }
}, readFileBytesSync(e) {
  let r = [];
  try {
    const t = _e(r, Te`fs.readFileBytesSync(${e})`, 0);
    return Y.readFileSync(e);
  } catch (o) {
    var n = o, i = 1;
  } finally {
    ve(r, n, i);
  }
}, readSync(e, t) {
  let n = [];
  try {
    const r = _e(n, Te`fs.readSync(${e}, ${t.length} bytes)`, 0);
    let o = void 0;
    try {
      o = Y.openSync(e, "r");
      let c = Buffer.alloc(t.length), u = Y.readSync(o, c, 0, t.length, 0);
      return { buffer: c, bytesRead: u };
    } finally {
      if (o) Y.closeSync(o);
    }
  } catch (i) {
    var s = i, a = 1;
  } finally {
    ve(n, s, a);
  }
}, appendFileSync(e, t, r) {
  let n = [];
  try {
    const o = _e(n, Te`fs.appendFileSync(${e}, ${t.length} chars)`, 0);
    if (r?.mode !== void 0) try {
      let c = Y.openSync(e, "ax", r.mode);
      try {
        Y.appendFileSync(c, t);
      } finally {
        Y.closeSync(c);
      }
      return;
    } catch (c) {
      if (Ve(c) !== "EEXIST") throw c;
    }
    Y.appendFileSync(e, t);
  } catch (i) {
    var s = i, a = 1;
  } finally {
    ve(n, s, a);
  }
}, copyFileSync(e, t) {
  let o = [];
  try {
    const r = _e(o, Te`fs.copyFileSync(${e} ${Sd} ${t})`, 0);
    Y.copyFileSync(e, t);
  } catch (n) {
    var i = n, s = 1;
  } finally {
    ve(o, i, s);
  }
}, unlinkSync(e) {
  let r = [];
  try {
    const t = _e(r, Te`fs.unlinkSync(${e})`, 0);
    Y.unlinkSync(e);
  } catch (o) {
    var n = o, i = 1;
  } finally {
    ve(r, n, i);
  }
}, renameSync(e, t) {
  let o = [];
  try {
    const r = _e(o, Te`fs.renameSync(${e} ${Sd} ${t})`, 0);
    Y.renameSync(e, t);
  } catch (n) {
    var i = n, s = 1;
  } finally {
    ve(o, i, s);
  }
}, linkSync(e, t) {
  let o = [];
  try {
    const r = _e(o, Te`fs.linkSync(${e} ${Sd} ${t})`, 0);
    Y.linkSync(e, t);
  } catch (n) {
    var i = n, s = 1;
  } finally {
    ve(o, i, s);
  }
}, symlinkSync(e, t, r) {
  let n = [];
  try {
    const o = _e(n, Te`fs.symlinkSync(${e} ${Sd} ${t})`, 0);
    Y.symlinkSync(e, t, r);
  } catch (i) {
    var s = i, a = 1;
  } finally {
    ve(n, s, a);
  }
}, readlinkSync(e) {
  let r = [];
  try {
    const t = _e(r, Te`fs.readlinkSync(${e})`, 0);
    return Y.readlinkSync(e);
  } catch (o) {
    var n = o, i = 1;
  } finally {
    ve(r, n, i);
  }
}, realpathSync(e) {
  let r = [];
  try {
    const t = _e(r, Te`fs.realpathSync(${e})`, 0);
    return Cr(Y.realpathSync(e));
  } catch (o) {
    var n = o, i = 1;
  } finally {
    ve(r, n, i);
  }
}, mkdirSync(e, t) {
  let n = [];
  try {
    const r = _e(n, Te`fs.mkdirSync(${e})`, 0);
    let o = { recursive: true };
    if (t?.mode !== void 0) o.mode = t.mode;
    try {
      Y.mkdirSync(e, o);
    } catch (c) {
      if (Ve(c) !== "EEXIST") throw c;
    }
  } catch (i) {
    var s = i, a = 1;
  } finally {
    ve(n, s, a);
  }
}, readdirSync(e) {
  let r = [];
  try {
    const t = _e(r, Te`fs.readdirSync(${e})`, 0);
    return Y.readdirSync(e, { withFileTypes: true });
  } catch (o) {
    var n = o, i = 1;
  } finally {
    ve(r, n, i);
  }
}, readdirStringSync(e) {
  let r = [];
  try {
    const t = _e(r, Te`fs.readdirStringSync(${e})`, 0);
    return Y.readdirSync(e);
  } catch (o) {
    var n = o, i = 1;
  } finally {
    ve(r, n, i);
  }
}, isDirEmptySync(e) {
  let o = [];
  try {
    const t = _e(o, Te`fs.isDirEmptySync(${e})`, 0);
    let r = this.readdirSync(e);
    return r.length === 0;
  } catch (n) {
    var i = n, s = 1;
  } finally {
    ve(o, i, s);
  }
}, rmdirSync(e) {
  let r = [];
  try {
    const t = _e(r, Te`fs.rmdirSync(${e})`, 0);
    Y.rmdirSync(e);
  } catch (o) {
    var n = o, i = 1;
  } finally {
    ve(r, n, i);
  }
}, rmSync(e, t) {
  let o = [];
  try {
    const r = _e(o, Te`fs.rmSync(${e})`, 0);
    Y.rmSync(e, t);
  } catch (n) {
    var i = n, s = 1;
  } finally {
    ve(o, i, s);
  }
}, createWriteStream(e) {
  return Y.createWriteStream(e);
}, async readFileBytes(e, t) {
  if (t === void 0) return AP(e);
  let r = await dH(e, "r");
  try {
    let { size: o } = await r.stat(), n = Math.min(o, t), i = Buffer.allocUnsafe(n), s = 0;
    while (s < n) {
      let { bytesRead: a } = await r.read(i, s, n - s, s);
      if (a === 0) break;
      s += a;
    }
    return s < n ? i.subarray(0, s) : i;
  } finally {
    await r.close();
  }
} };
var vH = _H;
function He() {
  return vH;
}
function SH(e, t) {
  if (e.destroyed) return;
  e.write(t);
}
function OP(e) {
  SH(process.stderr, e);
}
function $h(e) {
  return e.charAt(0).toUpperCase() + e.slice(1);
}
var CP = typeof String.prototype.isWellFormed === "function" ? Function.prototype.call.bind(String.prototype.isWellFormed) : void 0;
var wge = typeof String.prototype.toWellFormed === "function" ? Function.prototype.call.bind(String.prototype.toWellFormed) : void 0;
var wH = /api[_-]?key|secret|token|password|passwd|credential|bearer|authorization|auth[_-]?header|cookie|session[_-]?(?:id|key)|connection[_-]?string|(?:private|ssh|encryption|signing|access|deploy|master|license)[_-]?key|client[_-]?secret/i;
var NP = "[^\\s,;&}\\])]+";
var zP = "-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\\s\\S-]{64,}?-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----";
var kH = `[^\\s-]{0,4}${zP}['"\`]?`;
var jP = `\\[REDACTED\\]|"[^"]*"|'[^']*'|(?:Bearer|Basic)\\s+(?:\\[REDACTED\\]|${NP})|${kH}|${NP}`;
var EH = ["sk", "ant", "api"].join("-");
var PH = [{ id: "url-userinfo", source: ":\\/\\/([^/@\\s]+)@", confidence: "low" }, { id: "gcp-service-account", source: "\\b([a-z0-9-]+@[a-z0-9-]+\\.iam\\.gserviceaccount\\.com)\\b", flags: "i", confidence: "low" }, { id: "loose-anthropic-key", source: "\\b(sk-ant-?[\\w-]{10,})", confidence: "low" }, { id: "http-auth-scheme", source: "\\b(?:Bearer|Basic)\\s+([A-Za-z0-9+/=._~-]{20,})", flags: "i", confidence: "low" }, { id: "loose-jwt", source: "\\b(eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,})", confidence: "low" }, { id: "sensitive-assign", source: `(?:${wH.source})[\\w.-]*["']?\\s*[=:]\\s*(${jP})`, flags: "i", confidence: "low" }, { id: "cloud-env-var", source: `\\b(?:AWS|GOOGLE|GCP|GCLOUD|AZURE)_\\w+\\s*[=:]\\s*(${jP})`, flags: "i", confidence: "low" }, { id: "aws-access-token", source: "\\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\\b", confidence: "high" }, { id: "gcp-api-key", source: "\\b(AIza[\\w-]{35})(?![\\w-])", confidence: "high" }, { id: "google-oauth-client-secret", source: "\\bGOCSPX-[\\w-]{28}(?![\\w-])", confidence: "high" }, { id: "azure-ad-client-secret", source: `(?:^|[\\\\'"\\x60\\s>=:(,)])([a-zA-Z0-9_~.]{3}\\dQ~[a-zA-Z0-9_~.-]{31,34})(?:$|[\\\\'"\\x60\\s<),])`, confidence: "high" }, { id: "digitalocean-pat", source: `\\b(dop_v1_[a-f0-9]{64})(?:[\\x60'"\\s;]|\\\\[nr]|$)`, confidence: "high" }, { id: "digitalocean-access-token", source: `\\b(doo_v1_[a-f0-9]{64})(?:[\\x60'"\\s;]|\\\\[nr]|$)`, confidence: "high" }, { id: "anthropic-api-key", source: `\\b(${EH}03-[a-zA-Z0-9_\\-]{93}AA)(?:[\\x60'"\\s;]|\\\\[nr]|$)`, confidence: "high" }, { id: "anthropic-admin-api-key", source: `\\b(sk-ant-admin01-[a-zA-Z0-9_\\-]{93}AA)(?:[\\x60'"\\s;]|\\\\[nr]|$)`, confidence: "high" }, { id: "openai-api-key", source: "sk-[A-Za-z0-9_-]{8,200}T3BlbkFJ[A-Za-z0-9_-]{8,200}", confidence: "high" }, { id: "openai-legacy-api-key", source: "\\bsk-[a-zA-Z0-9]{48}(?![a-zA-Z0-9])", confidence: "high" }, { id: "huggingface-access-token", source: `\\b(hf_[a-zA-Z]{34})(?:[\\x60'"\\s;]|\\\\[nr]|$)`, confidence: "high" }, { id: "supabase-secret-key", source: "\\bsb_secret_[A-Za-z0-9_-]{20,}", confidence: "high" }, { id: "supabase-access-token", source: "\\bsbp_[a-z0-9]{40,}", confidence: "high" }, { id: "github-pat", source: "ghp_[0-9a-zA-Z]{36}", confidence: "high" }, { id: "github-fine-grained-pat", source: "github_pat_\\w{82}", confidence: "high" }, { id: "github-app-token", source: "(?:ghu|ghs)_[0-9a-zA-Z]{36}", confidence: "high" }, { id: "github-oauth", source: "gho_[0-9a-zA-Z]{36}", confidence: "high" }, { id: "github-refresh-token", source: "ghr_[0-9a-zA-Z]{36}", confidence: "high" }, { id: "gitlab-pat", source: "glpat-[\\w-]{20}", confidence: "high" }, { id: "gitlab-deploy-token", source: "gldt-[0-9a-zA-Z_\\-]{20}", confidence: "high" }, { id: "slack-bot-token", source: "xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*", confidence: "high" }, { id: "slack-user-token", source: "xox[pe](?:-[0-9]{10,13}){3}-[a-zA-Z0-9-]{28,34}", confidence: "high" }, { id: "slack-app-token", source: "xapp-\\d-[A-Z0-9]+-\\d+-[a-z0-9]+", flags: "i", confidence: "high" }, { id: "twilio-api-key", source: "SK[0-9a-fA-F]{32}", confidence: "high" }, { id: "sendgrid-api-token", source: `\\b(SG\\.[a-zA-Z0-9=_\\-.]{66})(?:[\\x60'"\\s;]|\\\\[nr]|$)`, confidence: "high" }, { id: "npm-access-token", source: `\\b(npm_[a-zA-Z0-9]{36})(?:[\\x60'"\\s;]|\\\\[nr]|$)`, confidence: "high" }, { id: "pypi-upload-token", source: "pypi-AgEIcHlwaS5vcmc[\\w-]{50,1000}", confidence: "high" }, { id: "databricks-api-token", source: `\\b(dapi[a-f0-9]{32}(?:-\\d)?)(?:[\\x60'"\\s;]|\\\\[nr]|$)`, confidence: "high" }, { id: "hashicorp-tf-api-token", source: "[a-zA-Z0-9]{14}\\.atlasv1\\.[a-zA-Z0-9\\-_=]{60,70}", confidence: "high" }, { id: "pulumi-api-token", source: `\\b(pul-[a-f0-9]{40})(?:[\\x60'"\\s;]|\\\\[nr]|$)`, confidence: "high" }, { id: "postman-api-token", source: `\\b(PMAK-[a-fA-F0-9]{24}-[a-fA-F0-9]{34})(?:[\\x60'"\\s;]|\\\\[nr]|$)`, confidence: "high" }, { id: "grafana-api-key", source: `\\b(eyJrIjoi[A-Za-z0-9+/]{70,400}={0,3})(?:[\\x60'"\\s;]|\\\\[nr]|$)`, confidence: "high" }, { id: "grafana-cloud-api-token", source: `\\b(glc_[A-Za-z0-9+/]{32,400}={0,3})(?:[\\x60'"\\s;]|\\\\[nr]|$)`, confidence: "high" }, { id: "grafana-service-account-token", source: `\\b(glsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8})(?:[\\x60'"\\s;]|\\\\[nr]|$)`, confidence: "high" }, { id: "sentry-user-token", source: `\\b(sntryu_[a-f0-9]{64})(?:[\\x60'"\\s;]|\\\\[nr]|$)`, confidence: "high" }, { id: "sentry-org-token", source: "\\bsntrys_eyJpYXQiO[a-zA-Z0-9+/]{10,200}(?:LCJyZWdpb25fdXJs|InJlZ2lvbl91cmwi|cmVnaW9uX3VybCI6)[a-zA-Z0-9+/]{10,200}={0,2}_[a-zA-Z0-9+/]{43}", confidence: "high" }, { id: "stripe-access-token", source: `\\b((?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99})(?:[\\x60'"\\s;]|\\\\[nr]|$)`, confidence: "high" }, { id: "shopify-access-token", source: "shpat_[a-fA-F0-9]{32}", confidence: "high" }, { id: "shopify-shared-secret", source: "shpss_[a-fA-F0-9]{32}", confidence: "high" }, { id: "private-key", source: zP, flags: "i", confidence: "high" }];
var UP = null;
function TH(e) {
  return PH.map((t) => ({ id: t.id, confidence: t.confidence, re: new RegExp(t.source, e ? (t.flags ?? "").replace("g", "") + "g" : t.flags ?? "") }));
}
function LP(e) {
  UP ??= TH(true);
  for (let t of UP) e = e.replace(t.re, (r, o) => {
    if (typeof o !== "string") return "[REDACTED]";
    let n = o.length >= 2 && (o[0] === '"' || o[0] === "'") && o.at(-1) === o[0] ? o[0] : "", i = r.lastIndexOf(o);
    return `${r.slice(0, i)}${n}[REDACTED]${n}${r.slice(i + o.length)}`;
  });
  return e;
}
var Dh = { verbose: 0, debug: 1, info: 2, warn: 3, error: 4 };
var OH = Ce(() => {
  let e = process.env.CLAUDE_CODE_DEBUG_LOG_LEVEL?.toLowerCase().trim();
  if (e && Object.hasOwn(Dh, e)) return e;
  return "debug";
});
var CH = false;
function kd() {
  if (typeof process > "u" || !Array.isArray(process.argv)) return [];
  let e = process.argv.indexOf("--");
  return e === -1 ? process.argv : process.argv.slice(0, e);
}
var Nh = Ce(() => {
  let e = kd();
  return CH || Ee(process.env.DEBUG) || Ee(process.env.DEBUG_SDK) || e.includes("--debug") || e.includes("-d") || VP() || e.some((t) => t.startsWith("--debug=")) || ZP() !== null;
});
var MH = Ce(() => {
  let e = kd().find((r) => r.startsWith("--debug="));
  if (!e) return null;
  let t = e.substring(8);
  return RP(t);
});
var VP = Ce(() => {
  let e = kd();
  return e.includes("--debug-to-stderr") || e.includes("-d2e");
});
var ZP = Ce(() => {
  let e = kd();
  for (let t = 0; t < e.length; t++) {
    let r = e[t];
    if (r.startsWith("--debug-file=")) return BP(r.substring(13));
    if (r === "--debug-file" && t + 1 < e.length) return BP(e[t + 1]);
  }
  return null;
});
function BP(e) {
  return $w(e) ? null : AH(e);
}
function DH(e) {
  if (!Nh()) return false;
  if (typeof process > "u" || typeof process.versions > "u" || typeof process.versions.node > "u") return false;
  let t = MH();
  return $P(e, t);
}
var NH = false;
var jH = 10485760;
var wd = null;
var Oh = Promise.resolve();
var Xa = -1;
var Ch = false;
var jh = null;
async function WP(e, t, r = jH) {
  if (Xa < 0) Xa = await RH(e).then((o) => o.size).catch(() => 0);
  else Xa += t;
  if (Xa <= r || Ch) return;
  Ch = true;
  try {
    let o = e.endsWith(".txt") ? `${e.slice(0, -4)}.1.txt` : `${e}.1`;
    try {
      await HP(e, o);
    } catch (n) {
      if (!Fr(n)) await Mh(o).catch(() => {
      }), await HP(e, o).catch(() => Mh(e).catch(() => {
      }));
    }
    Xa = 0;
  } finally {
    Ch = false;
  }
}
function KP(e) {
  return jh = zh(e, `${Rh()}.txt`), jh;
}
async function UH(e, t, r, o) {
  if (e) await IH(t, { recursive: true }).catch(() => {
  });
  let n = r;
  try {
    await FP(r, o);
  } catch (i) {
    if (!_h(i)) throw i;
    n = KP(r), await FP(n, o);
  }
  await WP(n, Buffer.byteLength(o)).catch(Uh), JP();
}
function Uh() {
}
function zH() {
  if (!wd) {
    let e = null;
    wd = PP({ writeFn: (t) => {
      let r = GP(), o = qP(r), n = e !== o;
      if (e = o, Nh()) {
        if (n) try {
          He().mkdirSync(o);
        } catch {
        }
        let i = r;
        try {
          He().appendFileSync(r, t);
        } catch (s) {
          if (!_h(s)) throw s;
          i = KP(r), He().appendFileSync(i, t);
        }
        WP(i, Buffer.byteLength(t)).catch(Uh), JP();
        return;
      }
      Oh = Oh.then(UH.bind(null, n, o, r, t)).catch(Uh);
    }, flushIntervalMs: 1e3, maxBufferSize: 100, immediateMode: Nh() }), IP(async () => {
      wd?.dispose(), await Oh;
    });
  }
  return wd;
}
function ee(e, { level: t } = { level: "debug" }) {
  if (Dh[t] < Dh[OH()]) return;
  if (!DH(e)) return;
  if (NH && e.includes(`
`)) e = pe(e);
  let o = `${(/* @__PURE__ */ new Date()).toISOString()} [${t.toUpperCase()}] ${LP(e.trim())}
`;
  if (VP()) {
    OP(o);
    return;
  }
  zH().write(o);
}
function GP() {
  return ZP() ?? jh ?? process.env.CLAUDE_CODE_DEBUG_LOGS_DIR ?? zh(Vt(), "debug", `${Rh()}.txt`);
}
var JP = Ce(async () => {
  try {
    let e = GP(), t = qP(e), r = zh(t, "latest");
    await Mh(r).catch(() => {
    }), await $H(e, r);
  } catch {
  }
});
var Zge = (() => {
  let e = process.env.CLAUDE_CODE_SLOW_OPERATION_THRESHOLD_MS;
  if (e !== void 0) {
    let t = Number(e);
    if (!Number.isNaN(t) && t >= 0) return t;
  }
  return 1 / 0;
})();
var LH = { [Symbol.dispose]() {
} };
function FH() {
  return LH;
}
var Te = FH;
function pe(e, t, r) {
  let n = [];
  try {
    const o = _e(n, Te`JSON.stringify(${e})`, 0);
    return JSON.stringify(e, t, r);
  } catch (i) {
    var s = i, a = 1;
  } finally {
    ve(n, s, a);
  }
}
var Ze = (e, t) => {
  let o = [];
  try {
    const r = _e(o, Te`JSON.parse(${e})`, 0);
    return typeof t > "u" ? JSON.parse(e) : JSON.parse(e, t);
  } catch (n) {
    var i = n, s = 1;
  } finally {
    ve(o, i, s);
  }
};
function HH(e) {
  let t = e.trim();
  return t.startsWith("{") && t.endsWith("}");
}
function YP(e, t) {
  let r = { ...e };
  if (t) {
    let o = t.enabled === true && t.failIfUnavailable === void 0 ? { ...t, failIfUnavailable: true } : t, n = r.settings;
    if (n && !HH(n)) throw Error("Cannot use both a settings file path and the sandbox option. Include the sandbox configuration in your settings file instead.");
    let i = { sandbox: o };
    if (n) try {
      i = { ...Ze(n), sandbox: o };
    } catch {
    }
    r.settings = pe(i);
  }
  return r;
}
var ZH = 2e3;
var Ed = /* @__PURE__ */ new Set();
var QP = false;
function WH() {
  for (let e of Ed) if (!e.killed) if (process.platform === "win32") try {
    e.stdin.end();
  } catch {
  }
  else e.kill("SIGTERM");
}
function KH(e) {
  if (Ed.add(e), !QP) QP = true, process.on("exit", WH);
}
var Lh = class {
  options;
  process;
  processStdin;
  processStdout;
  ready = false;
  abortController;
  exitError;
  exitListeners = [];
  abortHandler;
  forwardedAbort = Ks();
  pendingWrites = [];
  pendingEndInput = false;
  spawnResolve;
  spawnReject;
  spawnPromise;
  constructor(e) {
    this.options = e;
    if (this.abortController = e.abortController || Ks(), e.deferSpawn) this.spawnPromise = new Promise((t, r) => {
      this.spawnResolve = t, this.spawnReject = r;
    }), this.spawnPromise.catch(() => {
    });
    else this.initialize();
  }
  spawn() {
    try {
      this.initialize();
    } catch (t) {
      throw this.spawnAbort(Pr(t)), t;
    }
    let e = this.pendingWrites;
    if (this.pendingWrites = [], this.spawnResolve) this.spawnResolve(), this.spawnResolve = void 0, this.spawnReject = void 0;
    for (let t of e) this.write(t);
    if (this.pendingEndInput) this.pendingEndInput = false, this.processStdin?.end();
  }
  spawnAbort(e) {
    if (this.spawnReject) this.spawnReject(e), this.spawnReject = void 0, this.spawnResolve = void 0, this.pendingWrites = [];
  }
  updateEnv(e) {
    if (this.options.env) Object.assign(this.options.env, e);
    else this.options.env = { ...e };
  }
  updateResume(e) {
    this.options.resume = e;
  }
  getDefaultExecutable() {
    return ku() ? "bun" : "node";
  }
  spawnLocalProcess(e) {
    let { command: t, args: r, cwd: o, env: n, signal: i } = e, s = Ee(n.DEBUG_CLAUDE_AGENT_SDK) || this.options.stderr ? "pipe" : "ignore", a = BH(t, r, { cwd: o, stdio: ["pipe", "pipe", s], signal: i, env: n, windowsHide: true });
    if (Ee(n.DEBUG_CLAUDE_AGENT_SDK) || this.options.stderr) a.stderr.on("data", (u) => {
      let d = u.toString();
      if (xt(d), this.options.stderr) this.options.stderr(d);
    });
    return { stdin: a.stdin, stdout: a.stdout, get killed() {
      return a.killed;
    }, get exitCode() {
      return a.exitCode;
    }, kill: a.kill.bind(a), on: a.on.bind(a), once: a.once.bind(a), off: a.off.bind(a) };
  }
  initialize() {
    try {
      let { additionalDirectories: e = [], agent: t, betas: r, cwd: o, executable: n = this.getDefaultExecutable(), executableArgs: i = [], extraArgs: s = {}, pathToClaudeCodeExecutable: a, env: c = { ...process.env }, thinkingConfig: u, maxTurns: d, maxBudgetUsd: p, taskBudget: f, model: m, fallbackModel: g, jsonSchema: h, permissionMode: y, allowDangerouslySkipPermissions: v, permissionPromptToolName: w, continueConversation: x, resume: $, settingSources: U, skills: se, disallowedTools: Le = [], tools: Ye, mcpServers: Ft, strictMcpConfig: _t, canUseTool: to, includePartialMessages: Yo, plugins: Ar, sandbox: Fs } = this.options, { allowedTools: ln = [] } = this.options;
      if (se !== void 0) {
        let je = se === "all" ? ["Skill"] : se.map((wr) => `Skill(${wr})`), Ht = new Set(ln);
        ln = [...ln, ...je.filter((wr) => !Ht.has(wr))];
      }
      let Z = ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json"];
      if (u) {
        switch (u.type) {
          case "enabled":
            if (u.budgetTokens === void 0) Z.push("--thinking", "adaptive");
            else Z.push("--max-thinking-tokens", u.budgetTokens.toString());
            break;
          case "disabled":
            Z.push("--thinking", "disabled");
            break;
          case "adaptive":
            Z.push("--thinking", "adaptive");
            break;
        }
        if (u.type !== "disabled" && u.display) Z.push("--thinking-display", u.display);
      }
      if (this.options.effort) Z.push("--effort", this.options.effort);
      if (d) Z.push("--max-turns", d.toString());
      if (p !== void 0) Z.push("--max-budget-usd", p.toString());
      if (f) Z.push("--task-budget", f.total.toString());
      if (m) Z.push("--model", m);
      if (t) Z.push("--agent", t);
      if (r && r.length > 0) Z.push("--betas", r.join(","));
      if (h) Z.push("--json-schema", pe(h));
      if (this.options.debugFile) Z.push("--debug-file", this.options.debugFile);
      else if (this.options.debug) Z.push("--debug");
      if (!this.options.debugFile && !this.options.spawnClaudeCodeProcess) {
        let je = SE();
        if (je) Z.push("--debug-file", je);
      }
      if (to) {
        if (w) throw Error("canUseTool callback cannot be used with permissionPromptToolName. Please use one or the other.");
        Z.push("--permission-prompt-tool", "stdio");
      } else if (w) Z.push("--permission-prompt-tool", w);
      if (x) Z.push("--continue");
      if ($) Z.push("--resume", $);
      if (this.options.channels && this.options.channels.length > 0) Z.push("--channels", ...this.options.channels);
      if (ln.length > 0) Z.push("--allowedTools", ln.join(","));
      if (Le.length > 0) Z.push("--disallowedTools", Le.join(","));
      if (Ye !== void 0) if (Array.isArray(Ye)) if (Ye.length === 0) Z.push("--tools", "");
      else Z.push("--tools", Ye.join(","));
      else Z.push("--tools", "default");
      if (Ft && Object.keys(Ft).length > 0) Z.push("--mcp-config", pe({ mcpServers: Ft }));
      if (U !== void 0) Z.push(`--setting-sources=${U.join(",")}`);
      if (_t) Z.push("--strict-mcp-config");
      if (y) Z.push("--permission-mode", y);
      if (v) Z.push("--allow-dangerously-skip-permissions");
      if (g) {
        if (m && g === m) throw Error("Fallback model cannot be the same as the main model. Please specify a different model for fallbackModel option.");
        Z.push("--fallback-model", g);
      }
      if (this.options.includeHookEvents) Z.push("--include-hook-events");
      if (Yo) Z.push("--include-partial-messages");
      if (this.options.sessionMirror) Z.push("--session-mirror");
      for (let je of e) Z.push("--add-dir", je);
      if (Ar && Ar.length > 0) for (let je of Ar) if (je.type === "local") Z.push(je.skipMcpDiscovery ? "--plugin-dir-no-mcp" : "--plugin-dir", je.path);
      else throw Error(`Unsupported plugin type: ${je.type}`);
      if (this.options.forkSession) Z.push("--fork-session");
      if (this.options.resumeSessionAt) Z.push("--resume-session-at", this.options.resumeSessionAt);
      if (this.options.sessionId) Z.push("--session-id", this.options.sessionId);
      if (this.options.persistSession === false) Z.push("--no-session-persistence");
      if (this.options.managedSettings) Z.push("--managed-settings", this.options.managedSettings);
      let vu = { ...s ?? {} };
      if (this.options.settings) vu.settings = this.options.settings;
      let Su = YP(vu, Fs);
      for (let [je, Ht] of Object.entries(Su)) if (Ht === null) Z.push(`--${je}`);
      else Z.push(`--${je}`, Ht);
      if (!c.CLAUDE_CODE_ENTRYPOINT) c.CLAUDE_CODE_ENTRYPOINT = "sdk-ts";
      if (delete c.NODE_OPTIONS, Ee(c.DEBUG_CLAUDE_AGENT_SDK)) c.DEBUG = "1";
      else delete c.DEBUG;
      let Hs = GH(a), Bs = Hs ? a : n, qs = Hs ? [...i, ...Z] : [...i, a, ...Z], xu = { command: Bs, args: qs, cwd: o, env: c, signal: this.forwardedAbort.signal };
      if (this.options.spawnClaudeCodeProcess) xt(`Spawning Claude Code (custom): ${Bs} ${qs.join(" ")}`), this.process = this.options.spawnClaudeCodeProcess(xu);
      else xt(`Spawning Claude Code: ${Bs} ${qs.join(" ")}`), this.process = this.spawnLocalProcess(xu);
      if (this.processStdin = this.process.stdin, this.processStdout = this.process.stdout, KH(this.process), this.abortHandler = () => this.close(), this.abortController.signal.addEventListener("abort", this.abortHandler), this.abortController.signal.aborted) this.close();
      this.process.on("error", (je) => {
        if (this.ready = false, this.abortController.signal.aborted) this.exitError = new ot("Claude Code process aborted by user");
        else if (pE(je)) {
          let Ht = JH(a, Hs);
          this.exitError = ReferenceError(Ht), xt(this.exitError.message);
        } else this.exitError = Error(`Failed to spawn Claude Code process: ${je.message}`), xt(this.exitError.message);
      }), this.process.on("exit", (je, Ht) => {
        if (this.ready = false, this.abortController.signal.aborted) this.exitError = new ot("Claude Code process aborted by user");
        else {
          let wr = this.getProcessExitError(je, Ht);
          if (wr) this.exitError = wr, xt(wr.message);
        }
      }), this.ready = !this.abortController.signal.aborted;
    } catch (e) {
      throw this.ready = false, e;
    }
  }
  getProcessExitError(e, t) {
    if (e !== 0 && e !== null) return Error(`Claude Code process exited with code ${e}`);
    else if (t) return Error(`Claude Code process terminated by signal ${t}`);
    return;
  }
  write(e) {
    if (this.abortController.signal.aborted) throw new ot("Operation aborted");
    if (this.spawnResolve) {
      this.pendingWrites.push(e);
      return;
    }
    if (!this.ready || !this.processStdin) throw Error("ProcessTransport is not ready for writing");
    if (this.processStdin.writableEnded) {
      xt("[ProcessTransport] Dropping write to ended stdin stream");
      return;
    }
    if (this.process?.killed || this.process?.exitCode !== null) throw Error("Cannot write to terminated process");
    if (this.exitError) throw Error(`Cannot write to process that exited with error: ${this.exitError.message}`);
    xt(`[ProcessTransport] Writing to stdin: ${e.substring(0, 100)}`);
    try {
      if (!this.processStdin.write(e)) xt("[ProcessTransport] Write buffer full, data queued");
    } catch (t) {
      throw this.ready = false, Error(`Failed to write to process stdin: ${Si(t)}`);
    }
  }
  [Symbol.dispose]() {
    this.close();
  }
  close() {
    if (this.spawnAbort(this.abortController.signal.aborted ? new ot("Claude Code process aborted by user") : Error("Query closed before spawn")), this.processStdin) this.processStdin.end(), this.processStdin = void 0;
    if (this.abortHandler) this.abortController.signal.removeEventListener("abort", this.abortHandler), this.abortHandler = void 0;
    for (let { handler: r } of this.exitListeners) this.process?.off("exit", r);
    this.exitListeners = [];
    let e = () => {
      if (this.abortController.signal.aborted) this.forwardedAbort.abort(this.abortController.signal.reason);
    }, t = this.process;
    if (t && !t.killed && t.exitCode === null) setTimeout((r, o) => {
      if (r.exitCode !== null) {
        o();
        return;
      }
      if (process.platform === "win32") {
        setTimeout((n, i) => {
          if (n.exitCode === null) n.kill("SIGKILL");
          i();
        }, 5e3, r, o).unref();
        return;
      }
      r.kill("SIGTERM"), setTimeout((n) => {
        if (n.exitCode === null) n.kill("SIGKILL");
      }, 5e3, r).unref(), o();
    }, ZH, t, e).unref(), t.once("exit", () => Ed.delete(t));
    else if (t) Ed.delete(t), e();
    this.ready = false;
  }
  isReady() {
    return this.ready;
  }
  async *readMessages() {
    if (this.spawnPromise) await this.spawnPromise, this.spawnPromise = void 0;
    if (!this.processStdout) throw Error("ProcessTransport output stream not available");
    if (this.exitError) throw this.exitError;
    let e = VH({ input: this.processStdout }), t = this.process ? (() => {
      let r = this.process, o = () => e.close();
      return r.on("error", o), () => r.off("error", o);
    })() : void 0;
    if (this.exitError) e.close();
    try {
      for await (let r of e) if (r.trim()) {
        let o;
        try {
          o = Ze(r);
        } catch (n) {
          xt(`Non-JSON stdout: ${r}`);
          continue;
        }
        yield o;
      }
      if (this.exitError) throw this.exitError;
      await this.waitForExit();
    } catch (r) {
      throw r;
    } finally {
      t?.(), e.close();
    }
  }
  endInput() {
    if (this.spawnResolve) {
      this.pendingEndInput = true;
      return;
    }
    if (this.processStdin) this.processStdin.end();
  }
  getInputStream() {
    return this.processStdin;
  }
  onExit(e) {
    if (!this.process) return () => {
    };
    let t = (r, o) => {
      let n = this.getProcessExitError(r, o);
      e(n);
    };
    return this.process.on("exit", t), this.exitListeners.push({ callback: e, handler: t }), () => {
      if (this.process) this.process.off("exit", t);
      let r = this.exitListeners.findIndex((o) => o.handler === t);
      if (r !== -1) this.exitListeners.splice(r, 1);
    };
  }
  async waitForExit() {
    if (!this.process) {
      if (this.exitError) throw this.exitError;
      return;
    }
    if (this.process.exitCode !== null || this.process.killed || this.exitError) {
      if (this.exitError) throw this.exitError;
      return;
    }
    return new Promise((e, t) => {
      let r = (n, i) => {
        if (this.abortController.signal.aborted) {
          t(new ot("Operation aborted"));
          return;
        }
        let s = this.getProcessExitError(n, i);
        if (s) t(s);
        else e();
      };
      this.process.once("exit", r);
      let o = (n) => {
        this.process.off("exit", r), t(n);
      };
      this.process.once("error", o), this.process.once("exit", () => {
        this.process.off("error", o);
      });
    });
  }
};
function GH(e) {
  return ![".js", ".mjs", ".tsx", ".ts", ".jsx"].some((r) => e.endsWith(r));
}
function JH(e, t) {
  if (qH(e)) return t ? `Claude Code native binary at ${e} exists but failed to launch. This usually means the binary does not match this system's libc \u2014 e.g. spawning a musl-linked binary on a glibc Linux host fails because the musl dynamic loader (/lib/ld-musl-*) is missing. Specify a matching binary with options.pathToClaudeCodeExecutable.` : `Claude Code executable at ${e} exists but failed to launch.`;
  return t ? `Claude Code native binary not found at ${e}. Please ensure Claude Code is installed via native installer or specify a valid path with options.pathToClaudeCodeExecutable.` : `Claude Code executable not found at ${e}. Is options.pathToClaudeCodeExecutable set?`;
}
var Ai = "@anthropic-ai/claude-agent-sdk";
function YH() {
  if (process.platform !== "linux") return false;
  let e = typeof process.report?.getReport === "function" ? process.report.getReport() : null;
  return e != null && e.header?.glibcVersionRuntime === void 0;
}
function eT(e, t = process.platform, r = process.arch, o = XH, n = YH()) {
  let s = t === "win32" ? ".exe" : "", c = (t === "android" ? [`${Ai}-linux-${r}-android`] : t === "linux" ? n ? [`${Ai}-linux-${r}-musl`, `${Ai}-linux-${r}`] : [`${Ai}-linux-${r}`, `${Ai}-linux-${r}-musl`] : [`${Ai}-${t}-${r}`]).map((u) => `${u}/claude${s}`);
  for (let u of c) try {
    let d = e(u);
    if (o(d)) return d;
  } catch {
  }
  return null;
}
var Ya = class {
  returned;
  queue = [];
  readResolve;
  readReject;
  isDone = false;
  hasError;
  started = false;
  constructor(e) {
    this.returned = e;
  }
  [Symbol.asyncIterator]() {
    if (this.started) throw Error("Stream can only be iterated once");
    return this.started = true, this;
  }
  next() {
    if (this.queue.length > 0) return Promise.resolve({ done: false, value: this.queue.shift() });
    if (this.isDone) return Promise.resolve({ done: true, value: void 0 });
    if (this.hasError) return Promise.reject(this.hasError);
    return new Promise((e, t) => {
      this.readResolve = e, this.readReject = t;
    });
  }
  enqueue(e) {
    if (this.readResolve) {
      let t = this.readResolve;
      this.readResolve = void 0, this.readReject = void 0, t({ done: false, value: e });
    } else this.queue.push(e);
  }
  done() {
    if (this.isDone = true, this.readResolve) {
      let e = this.readResolve;
      this.readResolve = void 0, this.readReject = void 0, e({ done: true, value: void 0 });
    }
  }
  error(e) {
    if (this.hasError = e, this.readReject) {
      let t = this.readReject;
      this.readResolve = void 0, this.readReject = void 0, t(e);
    }
  }
  return() {
    if (this.isDone = true, this.returned) this.returned();
    return Promise.resolve({ done: true, value: void 0 });
  }
};
function QH() {
  return { eventQueue: [], sink: null };
}
var eB = QH();
function Oi(e, t) {
  let r = eB;
  if (r.sink === null) {
    r.eventQueue.push({ eventName: e, metadata: t, async: false });
    return;
  }
  r.sink.logEvent(e, t);
}
function Fh(e, t) {
  Oi("tengu_feature_ok", { feature_name: vi(e), ...t });
}
function Hh(e, t, r) {
  Oi("tengu_feature_bad", { ...r, feature_name: vi(e), error_code: t });
}
async function Jt(e, t, r) {
  try {
    let o = await t();
    return Fh(e), o;
  } catch (o) {
    throw Hh(e, r?.(o) ?? "error"), o;
  }
}
var Bh = class {
  sendMcpMessage;
  isClosed = false;
  constructor(e) {
    this.sendMcpMessage = e;
  }
  onclose;
  onerror;
  onmessage;
  async start() {
  }
  async send(e) {
    if (this.isClosed) throw Error("Transport is closed");
    this.sendMcpMessage(e);
  }
  async close() {
    if (this.isClosed) return;
    this.isClosed = true, this.onclose?.();
  }
};
var rT = Symbol("suppressControlResponse");
var qh = class {
  transport;
  isSingleUserTurn;
  canUseTool;
  hooks;
  abortController;
  jsonSchema;
  initConfig;
  onElicitation;
  getOAuthToken;
  getHostAuthToken;
  onUserDialog;
  pendingControlResponses = /* @__PURE__ */ new Map();
  cleanupPerformed = false;
  sdkMessages;
  inputStream = new Ya();
  initialization;
  cancelControllers = /* @__PURE__ */ new Map();
  hookCallbacks = /* @__PURE__ */ new Map();
  nextCallbackId = 0;
  initHooksPayload;
  sdkMcpTransports = /* @__PURE__ */ new Map();
  sdkMcpServerInstances = /* @__PURE__ */ new Map();
  pendingMcpResponses = /* @__PURE__ */ new Map();
  firstResultReceivedResolve;
  firstResultReceived = false;
  lastErrorResultText;
  transcriptMirrorBatcher;
  cleanupCallbacks = [];
  cleanupPromise;
  setIsSingleUserTurn(e) {
    this.isSingleUserTurn = e;
  }
  setTranscriptMirrorBatcher(e) {
    this.transcriptMirrorBatcher = e;
  }
  reportMirrorError(e, t) {
    let r = { type: "system", subtype: "mirror_error", error: t, key: e, uuid: Ja(), session_id: e.sessionId };
    this.inputStream.enqueue(r);
  }
  addCleanupCallback(e) {
    if (this.cleanupPerformed) e();
    else this.cleanupCallbacks.push(e);
  }
  isClosed() {
    return this.cleanupPerformed;
  }
  hasBidirectionalNeeds() {
    return this.sdkMcpTransports.size > 0 || this.hooks !== void 0 && Object.keys(this.hooks).length > 0 || this.canUseTool !== void 0 || this.onElicitation !== void 0 || this.onUserDialog !== void 0 || this.getOAuthToken !== void 0 || this.getHostAuthToken !== void 0;
  }
  constructor(e, t, r, o, n, i = /* @__PURE__ */ new Map(), s, a, c, u, d, p) {
    this.transport = e;
    this.isSingleUserTurn = t;
    this.canUseTool = r;
    this.hooks = o;
    this.abortController = n;
    this.jsonSchema = s;
    this.initConfig = a;
    this.onElicitation = c;
    this.getOAuthToken = u;
    this.getHostAuthToken = d;
    this.onUserDialog = p;
    for (let [f, m] of i) this.connectSdkMcpServer(f, m);
    this.sdkMessages = this.readSdkMessages(), this.readMessages(), this.initialization = this.initialize(), this.initialization.catch(() => {
    });
  }
  setError(e) {
    this.inputStream.error(e);
  }
  async stopTask(e) {
    await this.request({ subtype: "stop_task", task_id: e });
  }
  async backgroundTasks(e) {
    return (await this.request({ subtype: "background_tasks", tool_use_id: e })).response.backgrounded ?? true;
  }
  close() {
    this.cleanup();
  }
  cleanup(e) {
    if (this.cleanupPromise) return this.cleanupPromise;
    return this.cleanupPerformed = true, this.cleanupPromise = this.performCleanup(e), this.cleanupPromise;
  }
  async performCleanup(e) {
    for (let t of this.cleanupCallbacks) try {
      t();
    } catch {
    }
    if (this.cleanupCallbacks = [], this.transcriptMirrorBatcher) try {
      await this.transcriptMirrorBatcher.flush();
    } catch {
    }
    try {
      for (let r of this.cancelControllers.values()) r.abort();
      this.cancelControllers.clear(), this.transport.close();
      let t = e ?? Error("Query closed before response received");
      for (let { reject: r } of this.pendingControlResponses.values()) r(t);
      this.pendingControlResponses.clear();
      for (let { reject: r } of this.pendingMcpResponses.values()) r(t);
      this.pendingMcpResponses.clear(), this.hookCallbacks.clear();
      for (let r of this.sdkMcpTransports.values()) r.close().catch(() => {
      });
      if (this.sdkMcpTransports.clear(), e) this.inputStream.error(e);
      else this.inputStream.done();
    } catch (t) {
    }
    if (this.transport.waitForExit) {
      let t = new AbortController();
      try {
        await Promise.race([this.transport.waitForExit(), un(2e3, t.signal)]);
      } catch {
      } finally {
        t.abort();
      }
    }
  }
  next(...[e]) {
    return this.sdkMessages.next(...[e]);
  }
  async return(e) {
    return await this.cleanup(), this.sdkMessages.return(e);
  }
  async throw(e) {
    return await this.cleanup(), this.sdkMessages.throw(e);
  }
  [Symbol.asyncIterator]() {
    return this.sdkMessages;
  }
  async [Symbol.asyncDispose]() {
    await this.cleanup();
  }
  async readMessages() {
    try {
      for await (let e of this.transport.readMessages()) {
        if (e.type === "control_response") {
          let t = this.pendingControlResponses.get(e.response.request_id);
          if (t) t.handler(e.response);
          continue;
        } else if (e.type === "control_request") {
          this.handleControlRequest(e);
          continue;
        } else if (e.type === "control_cancel_request") {
          this.handleControlCancelRequest(e);
          continue;
        } else if (e.type === "keep_alive") continue;
        else if (e.type === "transcript_mirror") {
          this.transcriptMirrorBatcher?.enqueue(e.filePath, e.entries);
          continue;
        }
        if (e.type === "system" && (e.subtype === "post_turn_summary" || e.subtype === "task_summary")) {
          this.inputStream.enqueue(e);
          continue;
        }
        if (e.type === "result") {
          if (this.transcriptMirrorBatcher) await this.transcriptMirrorBatcher.flush();
          if (this.lastErrorResultText = e.is_error ? e.subtype === "success" ? e.result : e.errors.join("; ") : void 0, this.firstResultReceived = true, this.firstResultReceivedResolve) this.firstResultReceivedResolve();
          if (this.isSingleUserTurn) ee("[Query.readMessages] First result received for single-turn query, closing stdin"), this.transport.endInput();
        } else if (!(e.type === "system" && e.subtype === "session_state_changed")) this.lastErrorResultText = void 0;
        this.inputStream.enqueue(e);
      }
      if (this.transcriptMirrorBatcher) await this.transcriptMirrorBatcher.flush();
      if (this.firstResultReceivedResolve) this.firstResultReceivedResolve();
      this.inputStream.done(), this.cleanup();
    } catch (e) {
      if (this.transcriptMirrorBatcher) await this.transcriptMirrorBatcher.flush();
      if (this.firstResultReceivedResolve) this.firstResultReceivedResolve();
      if (this.lastErrorResultText !== void 0 && !(e instanceof ot)) {
        let t = Error(`Claude Code returned an error result: ${this.lastErrorResultText}`);
        ee(`[Query.readMessages] Replacing exit error with result text. Original: ${Si(e)}`), this.inputStream.error(t), this.cleanup(t);
        return;
      }
      this.inputStream.error(e), this.cleanup(e);
    }
  }
  async handleControlRequest(e) {
    if (this.cancelControllers.has(e.request_id)) {
      ee(`[Query.handleControlRequest] Duplicate delivery of in-flight request ${e.request_id} (${e.request.subtype}) \u2014 skipping`);
      return;
    }
    let t = new AbortController();
    this.cancelControllers.set(e.request_id, t);
    try {
      let r = await this.processControlRequest(e, t.signal);
      if (this.cleanupPerformed) return;
      if (r === rT) return;
      let o = { type: "control_response", response: { subtype: "success", request_id: e.request_id, response: r } };
      await Promise.resolve(this.transport.write(pe(o) + `
`));
    } catch (r) {
      if (this.cleanupPerformed) return;
      let o = { type: "control_response", response: { subtype: "error", request_id: e.request_id, error: Si(r) } };
      try {
        await Promise.resolve(this.transport.write(pe(o) + `
`));
      } catch (n) {
        ee(`[Query.handleControlRequest] Error-response write failed: ${Si(n)}`, { level: "error" });
      }
    } finally {
      this.cancelControllers.delete(e.request_id);
    }
  }
  handleControlCancelRequest(e) {
    let t = this.cancelControllers.get(e.request_id);
    if (t) t.abort(), this.cancelControllers.delete(e.request_id);
  }
  async processControlRequest(e, t) {
    if (e.request.subtype === "can_use_tool") {
      if (!this.canUseTool) throw Error("canUseTool callback is not provided.");
      return { ...await this.canUseTool(e.request.tool_name, e.request.input, { signal: t, suggestions: e.request.permission_suggestions, blockedPath: e.request.blocked_path, decisionReason: e.request.decision_reason, title: e.request.title, displayName: e.request.display_name, description: e.request.description, toolUseID: e.request.tool_use_id, agentID: e.request.agent_id }), toolUseID: e.request.tool_use_id };
    } else if (e.request.subtype === "hook_callback") return await this.handleHookCallbacks(e.request.callback_id, e.request.input, e.request.tool_use_id, t);
    else if (e.request.subtype === "mcp_message") {
      let r = e.request, o = this.sdkMcpTransports.get(r.server_name);
      if (!o) throw Error(`SDK MCP server not found: ${r.server_name}`);
      if ("method" in r.message && "id" in r.message && r.message.id !== null) return { mcp_response: await this.handleMcpControlRequest(r.server_name, r, o) };
      else {
        if (o.onmessage) o.onmessage(r.message);
        return { mcp_response: { jsonrpc: "2.0", result: {}, id: 0 } };
      }
    } else if (e.request.subtype === "elicitation") {
      let r = e.request;
      if (this.onElicitation) return await this.onElicitation({ serverName: r.mcp_server_name, message: r.message, mode: r.mode, url: r.url, elicitationId: r.elicitation_id, requestedSchema: r.requested_schema, title: r.title, displayName: r.display_name, description: r.description }, { signal: t });
      return { action: "decline" };
    } else if (e.request.subtype === "request_user_dialog") {
      if (this.onUserDialog) return await this.onUserDialog({ dialogKind: e.request.dialog_kind, payload: e.request.payload, toolUseID: e.request.tool_use_id }, { signal: t });
      return ee(`[Query] No onUserDialog handler for request_user_dialog (kind=${e.request.dialog_kind}) \u2014 staying silent so a capable client (or the worker's park deadline) settles it`), Oi("tengu_request_user_dialog_response_ignored", { shape: vi("auto_cancel") }), rT;
    } else if (e.request.subtype === "oauth_token_refresh") {
      if (!this.getOAuthToken) throw Error("getOAuthToken callback is not provided.");
      return { accessToken: await this.getOAuthToken({ signal: t }) ?? null };
    } else if (e.request.subtype === "host_auth_token_refresh") {
      if (!this.getHostAuthToken) throw Error("getHostAuthToken callback is not provided.");
      return { authToken: await this.getHostAuthToken({ signal: t }) ?? null };
    }
    throw Error("Unsupported control request subtype: " + e.request.subtype);
  }
  async *readSdkMessages() {
    try {
      for await (let e of this.inputStream) yield e;
    } finally {
      await this.cleanup();
    }
  }
  async initialize() {
    if (this.hooks && !this.initHooksPayload) {
      this.initHooksPayload = {};
      for (let [o, n] of Object.entries(this.hooks)) if (n.length > 0) this.initHooksPayload[o] = n.map((i) => {
        let s = [];
        for (let a of i.hooks) {
          let c = `hook_${this.nextCallbackId++}`;
          this.hookCallbacks.set(c, a), s.push(c);
        }
        return { matcher: i.matcher, hookCallbackIds: s, timeout: i.timeout };
      });
    }
    let e = this.sdkMcpTransports.size > 0 ? Array.from(this.sdkMcpTransports.keys()) : void 0, t = { subtype: "initialize", hooks: this.initHooksPayload, sdkMcpServers: e, jsonSchema: this.jsonSchema, systemPrompt: typeof this.initConfig?.systemPrompt === "string" ? [this.initConfig.systemPrompt] : this.initConfig?.systemPrompt, appendSystemPrompt: this.initConfig?.appendSystemPrompt, planModeInstructions: this.initConfig?.planModeInstructions, appendSubagentSystemPrompt: this.initConfig?.appendSubagentSystemPrompt, toolAliases: this.initConfig?.toolAliases, excludeDynamicSections: this.initConfig?.excludeDynamicSections, agents: this.initConfig?.agents, title: this.initConfig?.title, skills: Array.isArray(this.initConfig?.skills) ? this.initConfig.skills : void 0, webSearchIsolationExemptMcpServers: this.initConfig?.webSearchIsolationExemptMcpServers, promptSuggestions: this.initConfig?.promptSuggestions, agentProgressSummaries: this.initConfig?.agentProgressSummaries, forwardSubagentText: this.initConfig?.forwardSubagentText, supportedDialogKinds: this.initConfig?.supportedDialogKinds };
    return (await this.request(t)).response;
  }
  async interrupt() {
    return Jt("sdk_interrupt", async () => {
      await this.request({ subtype: "interrupt" });
    });
  }
  async setPermissionMode(e) {
    await this.request({ subtype: "set_permission_mode", mode: e });
  }
  async setMcpPermissionModeOverride(e, t) {
    return (await this.request({ subtype: "set_mcp_permission_mode_override", serverName: e, mode: t })).response ?? {};
  }
  async setModel(e) {
    await this.request({ subtype: "set_model", model: e });
  }
  async setMaxThinkingTokens(e, t) {
    await this.request({ subtype: "set_max_thinking_tokens", max_thinking_tokens: e, thinking_display: t });
  }
  async applyFlagSettings(e) {
    return Jt("sdk_apply_flag_settings", async () => {
      await this.request({ subtype: "apply_flag_settings", settings: e });
    });
  }
  async getSettings() {
    return (await this.request({ subtype: "get_settings" })).response;
  }
  async rewindFiles(e, t) {
    return Jt("sdk_rewind_files", async () => (await this.request({ subtype: "rewind_files", user_message_id: e, dry_run: t?.dryRun })).response);
  }
  async cancelAsyncMessage(e) {
    return (await this.request({ subtype: "cancel_async_message", message_uuid: e })).response.cancelled;
  }
  async seedReadState(e, t) {
    await this.request({ subtype: "seed_read_state", path: e, mtime: t });
  }
  async enableRemoteControl(e, t) {
    return (await this.request({ subtype: "remote_control", enabled: e, ...t !== void 0 && { name: t } })).response;
  }
  async submitFeedback(e, t) {
    return (await this.request({ subtype: "submit_feedback", description: e, surface: t?.surface })).response;
  }
  async generateSessionTitle(e, t) {
    return Jt("sdk_session_title_generate", async () => (await this.request({ subtype: "generate_session_title", description: e, persist: t?.persist })).response.title);
  }
  async askSideQuestion(e) {
    return Jt("sdk_side_question", async () => {
      let r = (await this.request({ subtype: "side_question", question: e })).response;
      return r.response === null ? null : { response: r.response, synthetic: r.synthetic ?? false };
    });
  }
  async launchUltrareview(e, t) {
    return (await this.request({ subtype: "ultrareview_launch", args: e, confirm: t?.confirm ?? false })).response;
  }
  async messageRated(e) {
    await this.request({ subtype: "message_rated", messageUuid: e.messageUuid, sentiment: e.sentiment, surface: e.surface, cleared: e.cleared ?? false });
  }
  processPendingPermissionRequests(e) {
    for (let t of e) if (t.request.subtype === "can_use_tool") this.handleControlRequest(t).catch(() => {
    });
  }
  processPendingUserDialogRequests(e) {
    for (let t of e) if (t.request.subtype === "request_user_dialog") this.handleControlRequest(t).catch(() => {
    });
  }
  request(e) {
    let t = Math.random().toString(36).substring(2, 15), r = { request_id: t, type: "control_request", request: e }, o = e.subtype === "initialize";
    return new Promise((n, i) => {
      this.pendingControlResponses.set(t, { handler: (s) => {
        if (this.pendingControlResponses.delete(t), s.subtype === "success") n(s);
        else i(Error(s.error));
        if (!o && (s.pending_permission_requests || s.pending_user_dialog_requests)) ee(`[Query] Ignoring prompt-redelivery fields on non-initialize response (subtype=${e.subtype})`);
        else {
          if (s.pending_permission_requests) this.processPendingPermissionRequests(s.pending_permission_requests);
          if (s.pending_user_dialog_requests) this.processPendingUserDialogRequests(s.pending_user_dialog_requests);
        }
      }, reject: i }), Promise.resolve(this.transport.write(pe(r) + `
`)).catch((s) => {
        this.pendingControlResponses.delete(t), i(s);
      });
    });
  }
  initializationResult() {
    return this.initialization;
  }
  reinitialize() {
    return Jt("sdk_reinitialize", () => this.initialize());
  }
  async supportedCommands() {
    return (await this.initialization).commands;
  }
  async supportedModels() {
    return (await this.initialization).models;
  }
  async supportedAgents() {
    return (await this.initialization).agents;
  }
  async reconnectMcpServer(e) {
    await this.request({ subtype: "mcp_reconnect", serverName: e });
  }
  async toggleMcpServer(e, t) {
    return Jt("sdk_mcp_toggle_server", async () => {
      await this.request({ subtype: "mcp_toggle", serverName: e, enabled: t });
    });
  }
  async enableChannel(e) {
    return Jt("sdk_mcp_enable_channel", async () => {
      await this.request({ subtype: "channel_enable", serverName: e });
    });
  }
  async mcpAuthenticate(e, t) {
    return (await this.request({ subtype: "mcp_authenticate", serverName: e, redirectUri: t })).response;
  }
  async mcpClearAuth(e) {
    return (await this.request({ subtype: "mcp_clear_auth", serverName: e })).response;
  }
  async mcpSubmitOAuthCallbackUrl(e, t) {
    return (await this.request({ subtype: "mcp_oauth_callback_url", serverName: e, callbackUrl: t })).response;
  }
  async claudeAuthenticate(e) {
    return (await this.request({ subtype: "claude_authenticate", loginWithClaudeAi: e })).response;
  }
  async claudeOAuthCallback(e, t) {
    return (await this.request({ subtype: "claude_oauth_callback", authorizationCode: e, state: t })).response;
  }
  async claudeOAuthWaitForCompletion() {
    return (await this.request({ subtype: "claude_oauth_wait_for_completion" })).response;
  }
  async mcpServerStatus() {
    return (await this.request({ subtype: "mcp_status" })).response.mcpServers;
  }
  async getContextUsage() {
    return (await this.request({ subtype: "get_context_usage" })).response;
  }
  async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
    return (await this.request({ subtype: "get_usage" })).response;
  }
  async readFile(e, t) {
    try {
      return (await this.request({ subtype: "read_file", path: e, max_bytes: t?.maxBytes, encoding: t?.encoding })).response;
    } catch {
      return null;
    }
  }
  async reloadPlugins() {
    return Jt("sdk_reload_plugins", async () => (await this.request({ subtype: "reload_plugins" })).response);
  }
  async reloadSkills() {
    return Jt("sdk_reload_skills", async () => (await this.request({ subtype: "reload_skills" })).response);
  }
  async setMcpServers(e) {
    return Jt("sdk_mcp_set_servers", async () => {
      let t = {}, r = {};
      for (let [a, c] of Object.entries(e)) if (c.type === "sdk" && "instance" in c) t[a] = c.instance;
      else r[a] = c;
      let o = new Set(this.sdkMcpServerInstances.keys()), n = new Set(Object.keys(t));
      for (let a of o) if (!n.has(a)) await this.disconnectSdkMcpServer(a);
      for (let [a, c] of Object.entries(t)) if (!o.has(a)) this.connectSdkMcpServer(a, c);
      let i = {};
      for (let a of Object.keys(t)) i[a] = { type: "sdk", name: a };
      return (await this.request({ subtype: "mcp_set_servers", servers: { ...r, ...i } })).response;
    });
  }
  async accountInfo() {
    return (await this.initialization).account;
  }
  async streamInput(e) {
    ee("[Query.streamInput] Starting to process input stream");
    try {
      let t = 0;
      for await (let r of e) {
        if (t++, ee(`[Query.streamInput] Processing message ${t}: ${r.type}`), this.abortController?.signal.aborted) break;
        await Promise.resolve(this.transport.write(pe(r) + `
`));
      }
      if (ee(`[Query.streamInput] Finished processing ${t} messages from input stream`), t > 0 && this.hasBidirectionalNeeds()) ee("[Query.streamInput] Has bidirectional needs, waiting for first result"), await this.waitForFirstResult();
      ee("[Query] Calling transport.endInput() to close stdin to CLI process"), this.transport.endInput();
    } catch (t) {
      if (!(t instanceof ot)) throw t;
    }
  }
  waitForFirstResult() {
    if (this.firstResultReceived) return ee("[Query.waitForFirstResult] Result already received, returning immediately"), Promise.resolve();
    return new Promise((e) => {
      if (this.abortController?.signal.aborted) {
        e();
        return;
      }
      this.abortController?.signal.addEventListener("abort", () => e(), { once: true }), this.firstResultReceivedResolve = e;
    });
  }
  handleHookCallbacks(e, t, r, o) {
    let n = this.hookCallbacks.get(e);
    if (!n) throw Error(`No hook callback found for ID: ${e}`);
    return n(t, r, { signal: o });
  }
  connectSdkMcpServer(e, t) {
    let r = new Bh((o) => this.sendMcpServerMessageToCli(e, o));
    this.sdkMcpTransports.set(e, r), this.sdkMcpServerInstances.set(e, t), t.connect(r).catch((o) => {
      if (this.sdkMcpTransports.get(e) === r) this.sdkMcpTransports.delete(e);
      if (this.sdkMcpServerInstances.get(e) === t) this.sdkMcpServerInstances.delete(e);
      ee(`[Query.connectSdkMcpServer] Failed to connect MCP server '${e}': ${o}`, { level: "error" });
    });
  }
  async disconnectSdkMcpServer(e) {
    let t = this.sdkMcpTransports.get(e);
    if (t) await t.close(), this.sdkMcpTransports.delete(e);
    this.sdkMcpServerInstances.delete(e);
  }
  sendMcpServerMessageToCli(e, t) {
    if ("id" in t && t.id !== null && t.id !== void 0) {
      let o = `${e}:${t.id}`, n = this.pendingMcpResponses.get(o);
      if (n) {
        n.resolve(t), this.pendingMcpResponses.delete(o);
        return;
      }
    }
    let r = { type: "control_request", request_id: Ja(), request: { subtype: "mcp_message", server_name: e, message: t } };
    Promise.resolve(this.transport.write(pe(r) + `
`)).catch((o) => {
      ee(`[Query.sendMcpServerMessageToCli] Transport write failed: ${o}`, { level: "error" });
    });
  }
  handleMcpControlRequest(e, t, r) {
    let o = "id" in t.message ? t.message.id : null, n = `${e}:${o}`;
    return new Promise((i, s) => {
      let a = () => {
        this.pendingMcpResponses.delete(n);
      }, c = (d) => {
        a(), i(d);
      }, u = (d) => {
        a(), s(d);
      };
      if (this.pendingMcpResponses.set(n, { resolve: c, reject: u }), r.onmessage) r.onmessage(t.message);
      else {
        a(), s(Error("No message handler registered"));
        return;
      }
    });
  }
};
var Pd = 500;
var Td = 1048576;
var tB = [200, 800];
var Vh = class {
  send;
  sendTimeoutMs;
  onError;
  maxPendingEntries;
  maxPendingBytes;
  backoffMs;
  pending = [];
  pendingEntries = 0;
  pendingBytes = 0;
  flushPromise = null;
  constructor(e, t = 6e4, r, o = Pd, n = Td, i = tB) {
    this.send = e;
    this.sendTimeoutMs = t;
    this.onError = r;
    this.maxPendingEntries = o;
    this.maxPendingBytes = n;
    this.backoffMs = i;
  }
  enqueue(e, t) {
    let r = pe(t).length;
    if (this.pending.push({ filePath: e, entries: t, bytes: r }), this.pendingEntries += t.length, this.pendingBytes += r, this.pendingEntries > this.maxPendingEntries || this.pendingBytes > this.maxPendingBytes) this.flushPromise = this.drain(), this.flushPromise.catch(() => {
    });
  }
  async flush() {
    let e = this.drain();
    if (this.flushPromise = e, await e, this.flushPromise === e) this.flushPromise = null;
  }
  async drain() {
    let e = this.flushPromise, t = this.pending.splice(0);
    if (this.pendingEntries = 0, this.pendingBytes = 0, e) await e;
    if (t.length === 0) return;
    await this.doFlush(t);
  }
  async doFlush(e) {
    let t = /* @__PURE__ */ new Map();
    for (let o of e) {
      let n = t.get(o.filePath);
      if (n) n.push(...o.entries);
      else t.set(o.filePath, o.entries.slice());
    }
    let r = this.backoffMs.length + 1;
    for (let [o, n] of t) {
      let i = `SessionStore.append() timed out after ${this.sendTimeoutMs}ms for ${o}`, s, a = 1;
      for (; a <= r; a++) try {
        await Mr(this.send(o, n), this.sendTimeoutMs, i), s = void 0;
        break;
      } catch (c) {
        if (s = Pr(c), s.message === i) break;
        let u = this.backoffMs[a - 1];
        if (u === void 0) break;
        await un(u);
      }
      if (s) {
        ee(`[TranscriptMirrorBatcher] flush failed for ${o} after ${a} attempt(s): ${s}`, { level: "error" });
        try {
          this.onError?.(o, s);
        } catch (c) {
          ee(`[TranscriptMirrorBatcher] onError callback threw: ${c}`, { level: "error" });
        }
      }
    }
  }
};
var Eg = Og(Y0(), 1);
var O6 = A6($6);
function zy(e) {
  let t = 0;
  for (let r = 0; r < e.length; r++) t = (t << 5) - t + e.charCodeAt(r) | 0;
  return t;
}
var j6 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function Se(e) {
  if (typeof e !== "string") return null;
  return j6.test(e) ? e : null;
}
async function ac(e, t) {
  return U6(e, t, "w");
}
async function U6(e, t, r) {
  let o = C6(e, { mode: 384, flags: r });
  try {
    for (let n of t) if (!o.write(JSON.stringify(n) + `
`)) await tR(o, "drain");
    o.end(), await tR(o, "finish");
  } catch (n) {
    throw o.destroy(), n;
  }
}
var zi = 200;
function z6(e) {
  return Math.abs(zy(e)).toString(36);
}
function wo(e) {
  let t = e.replace(/[^a-zA-Z0-9]/g, "-");
  if (t.length <= zi) return t;
  return `${t.slice(0, zi)}-${z6(e)}`;
}
var Nd = Buffer.from('{"type":"attribution-snapshot"');
var q6 = Buffer.from('{"type":"system"');
var sc = 10;
var V6 = Buffer.from([sc]);
function Jy(e, t) {
  let r = 0;
  for (let o of e) r += +!!t(o);
  return r;
}
function Ld(e) {
  return [...new Set(e)];
}
function EV() {
  return "prod";
}
var PV = "user:inference";
var DR = "user:profile";
var TV = "org:create_api_key";
var IV = [TV, DR];
var RV = [DR, PV, "user:sessions:claude_code", "user:mcp_servers", "user:file_upload", ...[]];
var f_e = Ld([...IV, ...RV]);
var $V = ["user:design:read", "user:design:write"];
var m_e = [...$V, "user:projects:read", "user:projects:write"];
var MR = { BASE_API_URL: "https://api.anthropic.com", CONSOLE_AUTHORIZE_URL: "https://platform.claude.com/oauth/authorize", CLAUDE_AI_AUTHORIZE_URL: "https://claude.com/cai/oauth/authorize", CLAUDE_AI_ORIGIN: "https://claude.ai", TOKEN_URL: "https://platform.claude.com/v1/oauth/token", API_KEY_URL: "https://api.anthropic.com/api/oauth/claude_cli/create_api_key", ROLES_URL: "https://api.anthropic.com/api/oauth/claude_cli/roles", CONSOLE_SUCCESS_URL: "https://platform.claude.com/buy_credits?returnUrl=/oauth/code/success%3Fapp%3Dclaude-code", CLAUDEAI_SUCCESS_URL: "https://platform.claude.com/oauth/code/success?app=claude-code", MANUAL_REDIRECT_URL: "https://platform.claude.com/oauth/code/callback", CLIENT_ID: "9d1c250a-e61b-44d9-88ed-5944d1962f5e", DESIGN_CLIENT_ID: "59637612-477b-4836-a601-b0589eda7704", OAUTH_FILE_SUFFIX: "", MCP_PROXY_URL: "https://mcp-proxy.anthropic.com", MCP_PROXY_PATH: "/v1/mcp/{server_id}" };
var AV = void 0;
function OV() {
  let e = process.env.CLAUDE_LOCAL_OAUTH_API_BASE?.replace(/\/$/, "") ?? "http://localhost:8000", t = process.env.CLAUDE_LOCAL_OAUTH_APPS_BASE?.replace(/\/$/, "") ?? "http://localhost:4000", r = process.env.CLAUDE_LOCAL_OAUTH_CONSOLE_BASE?.replace(/\/$/, "") ?? "http://localhost:3000";
  return { BASE_API_URL: e, CONSOLE_AUTHORIZE_URL: `${r}/oauth/authorize`, CLAUDE_AI_AUTHORIZE_URL: `${t}/oauth/authorize`, CLAUDE_AI_ORIGIN: t, TOKEN_URL: `${e}/v1/oauth/token`, API_KEY_URL: `${e}/api/oauth/claude_cli/create_api_key`, ROLES_URL: `${e}/api/oauth/claude_cli/roles`, CONSOLE_SUCCESS_URL: `${r}/buy_credits?returnUrl=/oauth/code/success%3Fapp%3Dclaude-code`, CLAUDEAI_SUCCESS_URL: `${r}/oauth/code/success?app=claude-code`, MANUAL_REDIRECT_URL: `${r}/oauth/code/callback`, CLIENT_ID: "22422756-60c9-4084-8eb7-27705fd5cf9a", DESIGN_CLIENT_ID: "00000000-0000-4000-8000-000000000000", OAUTH_FILE_SUFFIX: "-local-oauth", MCP_PROXY_URL: "http://localhost:8205", MCP_PROXY_PATH: "/v1/toolbox/shttp/mcp/{server_id}" };
}
var CV = ["https://beacon.claude-ai.staging.ant.dev", "https://claude.fedstart.com", "https://claude-staging.fedstart.com"];
function NR() {
  let e = (() => {
    switch (EV()) {
      case "local":
        return OV();
      case "staging":
        return AV ?? MR;
      case "prod":
        return MR;
    }
  })(), t = process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL;
  if (t) {
    let o = t.replace(/\/$/, "");
    if (!CV.includes(o)) throw Error("CLAUDE_CODE_CUSTOM_OAUTH_URL is not an approved endpoint.");
    e = { ...e, BASE_API_URL: o, CONSOLE_AUTHORIZE_URL: `${o}/oauth/authorize`, CLAUDE_AI_AUTHORIZE_URL: `${o}/oauth/authorize`, CLAUDE_AI_ORIGIN: o, TOKEN_URL: `${o}/v1/oauth/token`, API_KEY_URL: `${o}/api/oauth/claude_cli/create_api_key`, ROLES_URL: `${o}/api/oauth/claude_cli/roles`, CONSOLE_SUCCESS_URL: `${o}/oauth/code/success?app=claude-code`, CLAUDEAI_SUCCESS_URL: `${o}/oauth/code/success?app=claude-code`, MANUAL_REDIRECT_URL: `${o}/oauth/code/callback`, OAUTH_FILE_SUFFIX: "-custom-oauth" };
  }
  let r = process.env.CLAUDE_CODE_OAUTH_CLIENT_ID;
  if (r) e = { ...e, CLIENT_ID: r };
  return e;
}
var jR = "-credentials";
function UR(e = "") {
  let t = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, r = t !== void 0 ? !t : !process.env.CLAUDE_CONFIG_DIR, o = t !== void 0 ? t.normalize("NFC") : Vt(), n = r ? "" : `-${MV("sha256").update(o).digest("hex").substring(0, 8)}`;
  return `Claude Code${NR().OAUTH_FILE_SUFFIX}${e}${n}`;
}
var NV = /^[a-zA-Z0-9._-]+$/;
function zR() {
  if (process.platform === "win32") return "claude-code-user";
  let e;
  try {
    e = process.env.USER || DV().username;
  } catch {
    e = "claude-code-user";
  }
  if (!NV.test(e)) return "claude-code-user";
  return e;
}
var ae;
(function(e) {
  e.assertEqual = (n) => {
  };
  function t(n) {
  }
  e.assertIs = t;
  function r(n) {
    throw Error();
  }
  e.assertNever = r, e.arrayToEnum = (n) => {
    let i = {};
    for (let s of n) i[s] = s;
    return i;
  }, e.getValidEnumValues = (n) => {
    let i = e.objectKeys(n).filter((a) => typeof n[n[a]] !== "number"), s = {};
    for (let a of i) s[a] = n[a];
    return e.objectValues(s);
  }, e.objectValues = (n) => e.objectKeys(n).map(function(i) {
    return n[i];
  }), e.objectKeys = typeof Object.keys === "function" ? (n) => Object.keys(n) : (n) => {
    let i = [];
    for (let s in n) if (Object.prototype.hasOwnProperty.call(n, s)) i.push(s);
    return i;
  }, e.find = (n, i) => {
    for (let s of n) if (i(s)) return s;
    return;
  }, e.isInteger = typeof Number.isInteger === "function" ? (n) => Number.isInteger(n) : (n) => typeof n === "number" && Number.isFinite(n) && Math.floor(n) === n;
  function o(n, i = " | ") {
    return n.map((s) => typeof s === "string" ? `'${s}'` : s).join(i);
  }
  e.joinValues = o, e.jsonStringifyReplacer = (n, i) => {
    if (typeof i === "bigint") return i.toString();
    return i;
  };
})(ae || (ae = {}));
var LR;
(function(e) {
  e.mergeShapes = (t, r) => ({ ...t, ...r });
})(LR || (LR = {}));
var C = ae.arrayToEnum(["string", "nan", "number", "integer", "float", "boolean", "date", "bigint", "symbol", "function", "undefined", "null", "array", "object", "unknown", "promise", "void", "never", "map", "set"]);
var Vr = (e) => {
  switch (typeof e) {
    case "undefined":
      return C.undefined;
    case "string":
      return C.string;
    case "number":
      return Number.isNaN(e) ? C.nan : C.number;
    case "boolean":
      return C.boolean;
    case "function":
      return C.function;
    case "bigint":
      return C.bigint;
    case "symbol":
      return C.symbol;
    case "object":
      if (Array.isArray(e)) return C.array;
      if (e === null) return C.null;
      if (e.then && typeof e.then === "function" && e.catch && typeof e.catch === "function") return C.promise;
      if (typeof Map < "u" && e instanceof Map) return C.map;
      if (typeof Set < "u" && e instanceof Set) return C.set;
      if (typeof Date < "u" && e instanceof Date) return C.date;
      return C.object;
    default:
      return C.unknown;
  }
};
var I = ae.arrayToEnum(["invalid_type", "invalid_literal", "custom", "invalid_union", "invalid_union_discriminator", "invalid_enum_value", "unrecognized_keys", "invalid_arguments", "invalid_return_type", "invalid_date", "invalid_string", "too_small", "too_big", "invalid_intersection_types", "not_multiple_of", "not_finite"]);
var jt = class _jt extends Error {
  get errors() {
    return this.issues;
  }
  constructor(e) {
    super();
    this.issues = [], this.addIssue = (r) => {
      this.issues = [...this.issues, r];
    }, this.addIssues = (r = []) => {
      this.issues = [...this.issues, ...r];
    };
    let t = new.target.prototype;
    if (Object.setPrototypeOf) Object.setPrototypeOf(this, t);
    else this.__proto__ = t;
    this.name = "ZodError", this.issues = e;
  }
  format(e) {
    let t = e || function(n) {
      return n.message;
    }, r = { _errors: [] }, o = (n) => {
      for (let i of n.issues) if (i.code === "invalid_union") i.unionErrors.map(o);
      else if (i.code === "invalid_return_type") o(i.returnTypeError);
      else if (i.code === "invalid_arguments") o(i.argumentsError);
      else if (i.path.length === 0) r._errors.push(t(i));
      else {
        let s = r, a = 0;
        while (a < i.path.length) {
          let c = i.path[a];
          if (a !== i.path.length - 1) s[c] = s[c] || { _errors: [] };
          else s[c] = s[c] || { _errors: [] }, s[c]._errors.push(t(i));
          s = s[c], a++;
        }
      }
    };
    return o(this), r;
  }
  static assert(e) {
    if (!(e instanceof _jt)) throw Error(`Not a ZodError: ${e}`);
  }
  toString() {
    return this.message;
  }
  get message() {
    return JSON.stringify(this.issues, ae.jsonStringifyReplacer, 2);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
  flatten(e = (t) => t.message) {
    let t = {}, r = [];
    for (let o of this.issues) if (o.path.length > 0) {
      let n = o.path[0];
      t[n] = t[n] || [], t[n].push(e(o));
    } else r.push(e(o));
    return { formErrors: r, fieldErrors: t };
  }
  get formErrors() {
    return this.flatten();
  }
};
jt.create = (e) => new jt(e);
var jV = (e, t) => {
  let r;
  switch (e.code) {
    case I.invalid_type:
      if (e.received === C.undefined) r = "Required";
      else r = `Expected ${e.expected}, received ${e.received}`;
      break;
    case I.invalid_literal:
      r = `Invalid literal value, expected ${JSON.stringify(e.expected, ae.jsonStringifyReplacer)}`;
      break;
    case I.unrecognized_keys:
      r = `Unrecognized key(s) in object: ${ae.joinValues(e.keys, ", ")}`;
      break;
    case I.invalid_union:
      r = "Invalid input";
      break;
    case I.invalid_union_discriminator:
      r = `Invalid discriminator value. Expected ${ae.joinValues(e.options)}`;
      break;
    case I.invalid_enum_value:
      r = `Invalid enum value. Expected ${ae.joinValues(e.options)}, received '${e.received}'`;
      break;
    case I.invalid_arguments:
      r = "Invalid function arguments";
      break;
    case I.invalid_return_type:
      r = "Invalid function return type";
      break;
    case I.invalid_date:
      r = "Invalid date";
      break;
    case I.invalid_string:
      if (typeof e.validation === "object") if ("includes" in e.validation) {
        if (r = `Invalid input: must include "${e.validation.includes}"`, typeof e.validation.position === "number") r = `${r} at one or more positions greater than or equal to ${e.validation.position}`;
      } else if ("startsWith" in e.validation) r = `Invalid input: must start with "${e.validation.startsWith}"`;
      else if ("endsWith" in e.validation) r = `Invalid input: must end with "${e.validation.endsWith}"`;
      else ae.assertNever(e.validation);
      else if (e.validation !== "regex") r = `Invalid ${e.validation}`;
      else r = "Invalid";
      break;
    case I.too_small:
      if (e.type === "array") r = `Array must contain ${e.exact ? "exactly" : e.inclusive ? "at least" : "more than"} ${e.minimum} element(s)`;
      else if (e.type === "string") r = `String must contain ${e.exact ? "exactly" : e.inclusive ? "at least" : "over"} ${e.minimum} character(s)`;
      else if (e.type === "number") r = `Number must be ${e.exact ? "exactly equal to " : e.inclusive ? "greater than or equal to " : "greater than "}${e.minimum}`;
      else if (e.type === "bigint") r = `Number must be ${e.exact ? "exactly equal to " : e.inclusive ? "greater than or equal to " : "greater than "}${e.minimum}`;
      else if (e.type === "date") r = `Date must be ${e.exact ? "exactly equal to " : e.inclusive ? "greater than or equal to " : "greater than "}${new Date(Number(e.minimum))}`;
      else r = "Invalid input";
      break;
    case I.too_big:
      if (e.type === "array") r = `Array must contain ${e.exact ? "exactly" : e.inclusive ? "at most" : "less than"} ${e.maximum} element(s)`;
      else if (e.type === "string") r = `String must contain ${e.exact ? "exactly" : e.inclusive ? "at most" : "under"} ${e.maximum} character(s)`;
      else if (e.type === "number") r = `Number must be ${e.exact ? "exactly" : e.inclusive ? "less than or equal to" : "less than"} ${e.maximum}`;
      else if (e.type === "bigint") r = `BigInt must be ${e.exact ? "exactly" : e.inclusive ? "less than or equal to" : "less than"} ${e.maximum}`;
      else if (e.type === "date") r = `Date must be ${e.exact ? "exactly" : e.inclusive ? "smaller than or equal to" : "smaller than"} ${new Date(Number(e.maximum))}`;
      else r = "Invalid input";
      break;
    case I.custom:
      r = "Invalid input";
      break;
    case I.invalid_intersection_types:
      r = "Intersection results could not be merged";
      break;
    case I.not_multiple_of:
      r = `Number must be a multiple of ${e.multipleOf}`;
      break;
    case I.not_finite:
      r = "Number must be finite";
      break;
    default:
      r = t.defaultError, ae.assertNever(e);
  }
  return { message: r };
};
var Tn = jV;
var UV = Tn;
function lc() {
  return UV;
}
var Fd = (e) => {
  let { data: t, path: r, errorMaps: o, issueData: n } = e, i = [...r, ...n.path || []], s = { ...n, path: i };
  if (n.message !== void 0) return { ...n, path: i, message: n.message };
  let a = "", c = o.filter((u) => !!u).slice().reverse();
  for (let u of c) a = u(s, { data: t, defaultError: a }).message;
  return { ...n, path: i, message: a };
};
function j(e, t) {
  let r = lc(), o = Fd({ issueData: t, data: e.data, path: e.path, errorMaps: [e.common.contextualErrorMap, e.schemaErrorMap, r, r === Tn ? void 0 : Tn].filter((n) => !!n) });
  e.common.issues.push(o);
}
var at = class _at {
  constructor() {
    this.value = "valid";
  }
  dirty() {
    if (this.value === "valid") this.value = "dirty";
  }
  abort() {
    if (this.value !== "aborted") this.value = "aborted";
  }
  static mergeArray(e, t) {
    let r = [];
    for (let o of t) {
      if (o.status === "aborted") return W;
      if (o.status === "dirty") e.dirty();
      r.push(o.value);
    }
    return { status: e.value, value: r };
  }
  static async mergeObjectAsync(e, t) {
    let r = [];
    for (let o of t) {
      let n = await o.key, i = await o.value;
      r.push({ key: n, value: i });
    }
    return _at.mergeObjectSync(e, r);
  }
  static mergeObjectSync(e, t) {
    let r = {};
    for (let o of t) {
      let { key: n, value: i } = o;
      if (n.status === "aborted") return W;
      if (i.status === "aborted") return W;
      if (n.status === "dirty") e.dirty();
      if (i.status === "dirty") e.dirty();
      if (n.value !== "__proto__" && (typeof i.value < "u" || o.alwaysSet)) r[n.value] = i.value;
    }
    return { status: e.value, value: r };
  }
};
var W = Object.freeze({ status: "aborted" });
var Hi = (e) => ({ status: "dirty", value: e });
var mt = (e) => ({ status: "valid", value: e });
var Xy = (e) => e.status === "aborted";
var Yy = (e) => e.status === "dirty";
var ko = (e) => e.status === "valid";
var uc = (e) => typeof Promise < "u" && e instanceof Promise;
var F;
(function(e) {
  e.errToObj = (t) => typeof t === "string" ? { message: t } : t || {}, e.toString = (t) => typeof t === "string" ? t : t?.message;
})(F || (F = {}));
var dr = class {
  constructor(e, t, r, o) {
    this._cachedPath = [], this.parent = e, this.data = t, this._path = r, this._key = o;
  }
  get path() {
    if (!this._cachedPath.length) if (Array.isArray(this._key)) this._cachedPath.push(...this._path, ...this._key);
    else this._cachedPath.push(...this._path, this._key);
    return this._cachedPath;
  }
};
var FR = (e, t) => {
  if (ko(t)) return { success: true, data: t.value };
  else {
    if (!e.common.issues.length) throw Error("Validation failed but no issues detected.");
    return { success: false, get error() {
      if (this._error) return this._error;
      let r = new jt(e.common.issues);
      return this._error = r, this._error;
    } };
  }
};
function Q(e) {
  if (!e) return {};
  let { errorMap: t, invalid_type_error: r, required_error: o, description: n } = e;
  if (t && (r || o)) throw Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
  if (t) return { errorMap: t, description: n };
  return { errorMap: (s, a) => {
    let { message: c } = e;
    if (s.code === "invalid_enum_value") return { message: c ?? a.defaultError };
    if (typeof a.data > "u") return { message: c ?? o ?? a.defaultError };
    if (s.code !== "invalid_type") return { message: a.defaultError };
    return { message: c ?? r ?? a.defaultError };
  }, description: n };
}
var oe = class {
  get description() {
    return this._def.description;
  }
  _getType(e) {
    return Vr(e.data);
  }
  _getOrReturnCtx(e, t) {
    return t || { common: e.parent.common, data: e.data, parsedType: Vr(e.data), schemaErrorMap: this._def.errorMap, path: e.path, parent: e.parent };
  }
  _processInputParams(e) {
    return { status: new at(), ctx: { common: e.parent.common, data: e.data, parsedType: Vr(e.data), schemaErrorMap: this._def.errorMap, path: e.path, parent: e.parent } };
  }
  _parseSync(e) {
    let t = this._parse(e);
    if (uc(t)) throw Error("Synchronous parse encountered promise.");
    return t;
  }
  _parseAsync(e) {
    let t = this._parse(e);
    return Promise.resolve(t);
  }
  parse(e, t) {
    let r = this.safeParse(e, t);
    if (r.success) return r.data;
    throw r.error;
  }
  safeParse(e, t) {
    let r = { common: { issues: [], async: t?.async ?? false, contextualErrorMap: t?.errorMap }, path: t?.path || [], schemaErrorMap: this._def.errorMap, parent: null, data: e, parsedType: Vr(e) }, o = this._parseSync({ data: e, path: r.path, parent: r });
    return FR(r, o);
  }
  "~validate"(e) {
    let t = { common: { issues: [], async: !!this["~standard"].async }, path: [], schemaErrorMap: this._def.errorMap, parent: null, data: e, parsedType: Vr(e) };
    if (!this["~standard"].async) try {
      let r = this._parseSync({ data: e, path: [], parent: t });
      return ko(r) ? { value: r.value } : { issues: t.common.issues };
    } catch (r) {
      if (r?.message?.toLowerCase()?.includes("encountered")) this["~standard"].async = true;
      t.common = { issues: [], async: true };
    }
    return this._parseAsync({ data: e, path: [], parent: t }).then((r) => ko(r) ? { value: r.value } : { issues: t.common.issues });
  }
  async parseAsync(e, t) {
    let r = await this.safeParseAsync(e, t);
    if (r.success) return r.data;
    throw r.error;
  }
  async safeParseAsync(e, t) {
    let r = { common: { issues: [], contextualErrorMap: t?.errorMap, async: true }, path: t?.path || [], schemaErrorMap: this._def.errorMap, parent: null, data: e, parsedType: Vr(e) }, o = this._parse({ data: e, path: r.path, parent: r }), n = await (uc(o) ? o : Promise.resolve(o));
    return FR(r, n);
  }
  refine(e, t) {
    let r = (o) => {
      if (typeof t === "string" || typeof t > "u") return { message: t };
      else if (typeof t === "function") return t(o);
      else return t;
    };
    return this._refinement((o, n) => {
      let i = e(o), s = () => n.addIssue({ code: I.custom, ...r(o) });
      if (typeof Promise < "u" && i instanceof Promise) return i.then((a) => {
        if (!a) return s(), false;
        else return true;
      });
      if (!i) return s(), false;
      else return true;
    });
  }
  refinement(e, t) {
    return this._refinement((r, o) => {
      if (!e(r)) return o.addIssue(typeof t === "function" ? t(r, o) : t), false;
      else return true;
    });
  }
  _refinement(e) {
    return new Ir({ schema: this, typeName: R.ZodEffects, effect: { type: "refinement", refinement: e } });
  }
  superRefine(e) {
    return this._refinement(e);
  }
  constructor(e) {
    this.spa = this.safeParseAsync, this._def = e, this.parse = this.parse.bind(this), this.safeParse = this.safeParse.bind(this), this.parseAsync = this.parseAsync.bind(this), this.safeParseAsync = this.safeParseAsync.bind(this), this.spa = this.spa.bind(this), this.refine = this.refine.bind(this), this.refinement = this.refinement.bind(this), this.superRefine = this.superRefine.bind(this), this.optional = this.optional.bind(this), this.nullable = this.nullable.bind(this), this.nullish = this.nullish.bind(this), this.array = this.array.bind(this), this.promise = this.promise.bind(this), this.or = this.or.bind(this), this.and = this.and.bind(this), this.transform = this.transform.bind(this), this.brand = this.brand.bind(this), this.default = this.default.bind(this), this.catch = this.catch.bind(this), this.describe = this.describe.bind(this), this.pipe = this.pipe.bind(this), this.readonly = this.readonly.bind(this), this.isNullable = this.isNullable.bind(this), this.isOptional = this.isOptional.bind(this), this["~standard"] = { version: 1, vendor: "zod", validate: (t) => this["~validate"](t) };
  }
  optional() {
    return Xt.create(this, this._def);
  }
  nullable() {
    return In.create(this, this._def);
  }
  nullish() {
    return this.nullable().optional();
  }
  array() {
    return Tr.create(this);
  }
  promise() {
    return Wi.create(this, this._def);
  }
  or(e) {
    return gc.create([this, e], this._def);
  }
  and(e) {
    return hc.create(this, e, this._def);
  }
  transform(e) {
    return new Ir({ ...Q(this._def), schema: this, typeName: R.ZodEffects, effect: { type: "transform", transform: e } });
  }
  default(e) {
    let t = typeof e === "function" ? e : () => e;
    return new vc({ ...Q(this._def), innerType: this, defaultValue: t, typeName: R.ZodDefault });
  }
  brand() {
    return new rb({ typeName: R.ZodBranded, type: this, ...Q(this._def) });
  }
  catch(e) {
    let t = typeof e === "function" ? e : () => e;
    return new Sc({ ...Q(this._def), innerType: this, catchValue: t, typeName: R.ZodCatch });
  }
  describe(e) {
    return new this.constructor({ ...this._def, description: e });
  }
  pipe(e) {
    return Gd.create(this, e);
  }
  readonly() {
    return xc.create(this);
  }
  isOptional() {
    return this.safeParse(void 0).success;
  }
  isNullable() {
    return this.safeParse(null).success;
  }
};
var zV = /^c[^\s-]{8,}$/i;
var LV = /^[0-9a-z]+$/;
var FV = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
var HV = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
var BV = /^[a-z0-9_-]{21}$/i;
var qV = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
var VV = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var ZV = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
var WV = "^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$";
var Qy;
var KV = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var GV = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
var JV = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
var XV = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var YV = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
var QV = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
var HR = "((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))";
var eZ = new RegExp(`^${HR}$`);
function BR(e) {
  let t = "[0-5]\\d";
  if (e.precision) t = `${t}\\.\\d{${e.precision}}`;
  else if (e.precision == null) t = `${t}(\\.\\d+)?`;
  let r = e.precision ? "+" : "?";
  return `([01]\\d|2[0-3]):[0-5]\\d(:${t})${r}`;
}
function tZ(e) {
  return new RegExp(`^${BR(e)}$`);
}
function rZ(e) {
  let t = `${HR}T${BR(e)}`, r = [];
  if (r.push(e.local ? "Z?" : "Z"), e.offset) r.push("([+-]\\d{2}:?\\d{2})");
  return t = `${t}(${r.join("|")})`, new RegExp(`^${t}$`);
}
function nZ(e, t) {
  if ((t === "v4" || !t) && KV.test(e)) return true;
  if ((t === "v6" || !t) && JV.test(e)) return true;
  return false;
}
function oZ(e, t) {
  if (!qV.test(e)) return false;
  try {
    let [r] = e.split(".");
    if (!r) return false;
    let o = r.replace(/-/g, "+").replace(/_/g, "/").padEnd(r.length + (4 - r.length % 4) % 4, "="), n = JSON.parse(atob(o));
    if (typeof n !== "object" || n === null) return false;
    if ("typ" in n && n?.typ !== "JWT") return false;
    if (!n.alg) return false;
    if (t && n.alg !== t) return false;
    return true;
  } catch {
    return false;
  }
}
function iZ(e, t) {
  if ((t === "v4" || !t) && GV.test(e)) return true;
  if ((t === "v6" || !t) && XV.test(e)) return true;
  return false;
}
var Wr = class _Wr extends oe {
  _parse(e) {
    if (this._def.coerce) e.data = String(e.data);
    if (this._getType(e) !== C.string) {
      let n = this._getOrReturnCtx(e);
      return j(n, { code: I.invalid_type, expected: C.string, received: n.parsedType }), W;
    }
    let r = new at(), o = void 0;
    for (let n of this._def.checks) if (n.kind === "min") {
      if (e.data.length < n.value) o = this._getOrReturnCtx(e, o), j(o, { code: I.too_small, minimum: n.value, type: "string", inclusive: true, exact: false, message: n.message }), r.dirty();
    } else if (n.kind === "max") {
      if (e.data.length > n.value) o = this._getOrReturnCtx(e, o), j(o, { code: I.too_big, maximum: n.value, type: "string", inclusive: true, exact: false, message: n.message }), r.dirty();
    } else if (n.kind === "length") {
      let i = e.data.length > n.value, s = e.data.length < n.value;
      if (i || s) {
        if (o = this._getOrReturnCtx(e, o), i) j(o, { code: I.too_big, maximum: n.value, type: "string", inclusive: true, exact: true, message: n.message });
        else if (s) j(o, { code: I.too_small, minimum: n.value, type: "string", inclusive: true, exact: true, message: n.message });
        r.dirty();
      }
    } else if (n.kind === "email") {
      if (!ZV.test(e.data)) o = this._getOrReturnCtx(e, o), j(o, { validation: "email", code: I.invalid_string, message: n.message }), r.dirty();
    } else if (n.kind === "emoji") {
      if (!Qy) Qy = new RegExp(WV, "u");
      if (!Qy.test(e.data)) o = this._getOrReturnCtx(e, o), j(o, { validation: "emoji", code: I.invalid_string, message: n.message }), r.dirty();
    } else if (n.kind === "uuid") {
      if (!HV.test(e.data)) o = this._getOrReturnCtx(e, o), j(o, { validation: "uuid", code: I.invalid_string, message: n.message }), r.dirty();
    } else if (n.kind === "nanoid") {
      if (!BV.test(e.data)) o = this._getOrReturnCtx(e, o), j(o, { validation: "nanoid", code: I.invalid_string, message: n.message }), r.dirty();
    } else if (n.kind === "cuid") {
      if (!zV.test(e.data)) o = this._getOrReturnCtx(e, o), j(o, { validation: "cuid", code: I.invalid_string, message: n.message }), r.dirty();
    } else if (n.kind === "cuid2") {
      if (!LV.test(e.data)) o = this._getOrReturnCtx(e, o), j(o, { validation: "cuid2", code: I.invalid_string, message: n.message }), r.dirty();
    } else if (n.kind === "ulid") {
      if (!FV.test(e.data)) o = this._getOrReturnCtx(e, o), j(o, { validation: "ulid", code: I.invalid_string, message: n.message }), r.dirty();
    } else if (n.kind === "url") try {
      new URL(e.data);
    } catch {
      o = this._getOrReturnCtx(e, o), j(o, { validation: "url", code: I.invalid_string, message: n.message }), r.dirty();
    }
    else if (n.kind === "regex") {
      if (n.regex.lastIndex = 0, !n.regex.test(e.data)) o = this._getOrReturnCtx(e, o), j(o, { validation: "regex", code: I.invalid_string, message: n.message }), r.dirty();
    } else if (n.kind === "trim") e.data = e.data.trim();
    else if (n.kind === "includes") {
      if (!e.data.includes(n.value, n.position)) o = this._getOrReturnCtx(e, o), j(o, { code: I.invalid_string, validation: { includes: n.value, position: n.position }, message: n.message }), r.dirty();
    } else if (n.kind === "toLowerCase") e.data = e.data.toLowerCase();
    else if (n.kind === "toUpperCase") e.data = e.data.toUpperCase();
    else if (n.kind === "startsWith") {
      if (!e.data.startsWith(n.value)) o = this._getOrReturnCtx(e, o), j(o, { code: I.invalid_string, validation: { startsWith: n.value }, message: n.message }), r.dirty();
    } else if (n.kind === "endsWith") {
      if (!e.data.endsWith(n.value)) o = this._getOrReturnCtx(e, o), j(o, { code: I.invalid_string, validation: { endsWith: n.value }, message: n.message }), r.dirty();
    } else if (n.kind === "datetime") {
      if (!rZ(n).test(e.data)) o = this._getOrReturnCtx(e, o), j(o, { code: I.invalid_string, validation: "datetime", message: n.message }), r.dirty();
    } else if (n.kind === "date") {
      if (!eZ.test(e.data)) o = this._getOrReturnCtx(e, o), j(o, { code: I.invalid_string, validation: "date", message: n.message }), r.dirty();
    } else if (n.kind === "time") {
      if (!tZ(n).test(e.data)) o = this._getOrReturnCtx(e, o), j(o, { code: I.invalid_string, validation: "time", message: n.message }), r.dirty();
    } else if (n.kind === "duration") {
      if (!VV.test(e.data)) o = this._getOrReturnCtx(e, o), j(o, { validation: "duration", code: I.invalid_string, message: n.message }), r.dirty();
    } else if (n.kind === "ip") {
      if (!nZ(e.data, n.version)) o = this._getOrReturnCtx(e, o), j(o, { validation: "ip", code: I.invalid_string, message: n.message }), r.dirty();
    } else if (n.kind === "jwt") {
      if (!oZ(e.data, n.alg)) o = this._getOrReturnCtx(e, o), j(o, { validation: "jwt", code: I.invalid_string, message: n.message }), r.dirty();
    } else if (n.kind === "cidr") {
      if (!iZ(e.data, n.version)) o = this._getOrReturnCtx(e, o), j(o, { validation: "cidr", code: I.invalid_string, message: n.message }), r.dirty();
    } else if (n.kind === "base64") {
      if (!YV.test(e.data)) o = this._getOrReturnCtx(e, o), j(o, { validation: "base64", code: I.invalid_string, message: n.message }), r.dirty();
    } else if (n.kind === "base64url") {
      if (!QV.test(e.data)) o = this._getOrReturnCtx(e, o), j(o, { validation: "base64url", code: I.invalid_string, message: n.message }), r.dirty();
    } else ae.assertNever(n);
    return { status: r.value, value: e.data };
  }
  _regex(e, t, r) {
    return this.refinement((o) => e.test(o), { validation: t, code: I.invalid_string, ...F.errToObj(r) });
  }
  _addCheck(e) {
    return new _Wr({ ...this._def, checks: [...this._def.checks, e] });
  }
  email(e) {
    return this._addCheck({ kind: "email", ...F.errToObj(e) });
  }
  url(e) {
    return this._addCheck({ kind: "url", ...F.errToObj(e) });
  }
  emoji(e) {
    return this._addCheck({ kind: "emoji", ...F.errToObj(e) });
  }
  uuid(e) {
    return this._addCheck({ kind: "uuid", ...F.errToObj(e) });
  }
  nanoid(e) {
    return this._addCheck({ kind: "nanoid", ...F.errToObj(e) });
  }
  cuid(e) {
    return this._addCheck({ kind: "cuid", ...F.errToObj(e) });
  }
  cuid2(e) {
    return this._addCheck({ kind: "cuid2", ...F.errToObj(e) });
  }
  ulid(e) {
    return this._addCheck({ kind: "ulid", ...F.errToObj(e) });
  }
  base64(e) {
    return this._addCheck({ kind: "base64", ...F.errToObj(e) });
  }
  base64url(e) {
    return this._addCheck({ kind: "base64url", ...F.errToObj(e) });
  }
  jwt(e) {
    return this._addCheck({ kind: "jwt", ...F.errToObj(e) });
  }
  ip(e) {
    return this._addCheck({ kind: "ip", ...F.errToObj(e) });
  }
  cidr(e) {
    return this._addCheck({ kind: "cidr", ...F.errToObj(e) });
  }
  datetime(e) {
    if (typeof e === "string") return this._addCheck({ kind: "datetime", precision: null, offset: false, local: false, message: e });
    return this._addCheck({ kind: "datetime", precision: typeof e?.precision > "u" ? null : e?.precision, offset: e?.offset ?? false, local: e?.local ?? false, ...F.errToObj(e?.message) });
  }
  date(e) {
    return this._addCheck({ kind: "date", message: e });
  }
  time(e) {
    if (typeof e === "string") return this._addCheck({ kind: "time", precision: null, message: e });
    return this._addCheck({ kind: "time", precision: typeof e?.precision > "u" ? null : e?.precision, ...F.errToObj(e?.message) });
  }
  duration(e) {
    return this._addCheck({ kind: "duration", ...F.errToObj(e) });
  }
  regex(e, t) {
    return this._addCheck({ kind: "regex", regex: e, ...F.errToObj(t) });
  }
  includes(e, t) {
    return this._addCheck({ kind: "includes", value: e, position: t?.position, ...F.errToObj(t?.message) });
  }
  startsWith(e, t) {
    return this._addCheck({ kind: "startsWith", value: e, ...F.errToObj(t) });
  }
  endsWith(e, t) {
    return this._addCheck({ kind: "endsWith", value: e, ...F.errToObj(t) });
  }
  min(e, t) {
    return this._addCheck({ kind: "min", value: e, ...F.errToObj(t) });
  }
  max(e, t) {
    return this._addCheck({ kind: "max", value: e, ...F.errToObj(t) });
  }
  length(e, t) {
    return this._addCheck({ kind: "length", value: e, ...F.errToObj(t) });
  }
  nonempty(e) {
    return this.min(1, F.errToObj(e));
  }
  trim() {
    return new _Wr({ ...this._def, checks: [...this._def.checks, { kind: "trim" }] });
  }
  toLowerCase() {
    return new _Wr({ ...this._def, checks: [...this._def.checks, { kind: "toLowerCase" }] });
  }
  toUpperCase() {
    return new _Wr({ ...this._def, checks: [...this._def.checks, { kind: "toUpperCase" }] });
  }
  get isDatetime() {
    return !!this._def.checks.find((e) => e.kind === "datetime");
  }
  get isDate() {
    return !!this._def.checks.find((e) => e.kind === "date");
  }
  get isTime() {
    return !!this._def.checks.find((e) => e.kind === "time");
  }
  get isDuration() {
    return !!this._def.checks.find((e) => e.kind === "duration");
  }
  get isEmail() {
    return !!this._def.checks.find((e) => e.kind === "email");
  }
  get isURL() {
    return !!this._def.checks.find((e) => e.kind === "url");
  }
  get isEmoji() {
    return !!this._def.checks.find((e) => e.kind === "emoji");
  }
  get isUUID() {
    return !!this._def.checks.find((e) => e.kind === "uuid");
  }
  get isNANOID() {
    return !!this._def.checks.find((e) => e.kind === "nanoid");
  }
  get isCUID() {
    return !!this._def.checks.find((e) => e.kind === "cuid");
  }
  get isCUID2() {
    return !!this._def.checks.find((e) => e.kind === "cuid2");
  }
  get isULID() {
    return !!this._def.checks.find((e) => e.kind === "ulid");
  }
  get isIP() {
    return !!this._def.checks.find((e) => e.kind === "ip");
  }
  get isCIDR() {
    return !!this._def.checks.find((e) => e.kind === "cidr");
  }
  get isBase64() {
    return !!this._def.checks.find((e) => e.kind === "base64");
  }
  get isBase64url() {
    return !!this._def.checks.find((e) => e.kind === "base64url");
  }
  get minLength() {
    let e = null;
    for (let t of this._def.checks) if (t.kind === "min") {
      if (e === null || t.value > e) e = t.value;
    }
    return e;
  }
  get maxLength() {
    let e = null;
    for (let t of this._def.checks) if (t.kind === "max") {
      if (e === null || t.value < e) e = t.value;
    }
    return e;
  }
};
Wr.create = (e) => new Wr({ checks: [], typeName: R.ZodString, coerce: e?.coerce ?? false, ...Q(e) });
function sZ(e, t) {
  let r = (e.toString().split(".")[1] || "").length, o = (t.toString().split(".")[1] || "").length, n = r > o ? r : o, i = Number.parseInt(e.toFixed(n).replace(".", "")), s = Number.parseInt(t.toFixed(n).replace(".", ""));
  return i % s / 10 ** n;
}
var qi = class _qi extends oe {
  constructor() {
    super(...arguments);
    this.min = this.gte, this.max = this.lte, this.step = this.multipleOf;
  }
  _parse(e) {
    if (this._def.coerce) e.data = Number(e.data);
    if (this._getType(e) !== C.number) {
      let n = this._getOrReturnCtx(e);
      return j(n, { code: I.invalid_type, expected: C.number, received: n.parsedType }), W;
    }
    let r = void 0, o = new at();
    for (let n of this._def.checks) if (n.kind === "int") {
      if (!ae.isInteger(e.data)) r = this._getOrReturnCtx(e, r), j(r, { code: I.invalid_type, expected: "integer", received: "float", message: n.message }), o.dirty();
    } else if (n.kind === "min") {
      if (n.inclusive ? e.data < n.value : e.data <= n.value) r = this._getOrReturnCtx(e, r), j(r, { code: I.too_small, minimum: n.value, type: "number", inclusive: n.inclusive, exact: false, message: n.message }), o.dirty();
    } else if (n.kind === "max") {
      if (n.inclusive ? e.data > n.value : e.data >= n.value) r = this._getOrReturnCtx(e, r), j(r, { code: I.too_big, maximum: n.value, type: "number", inclusive: n.inclusive, exact: false, message: n.message }), o.dirty();
    } else if (n.kind === "multipleOf") {
      if (sZ(e.data, n.value) !== 0) r = this._getOrReturnCtx(e, r), j(r, { code: I.not_multiple_of, multipleOf: n.value, message: n.message }), o.dirty();
    } else if (n.kind === "finite") {
      if (!Number.isFinite(e.data)) r = this._getOrReturnCtx(e, r), j(r, { code: I.not_finite, message: n.message }), o.dirty();
    } else ae.assertNever(n);
    return { status: o.value, value: e.data };
  }
  gte(e, t) {
    return this.setLimit("min", e, true, F.toString(t));
  }
  gt(e, t) {
    return this.setLimit("min", e, false, F.toString(t));
  }
  lte(e, t) {
    return this.setLimit("max", e, true, F.toString(t));
  }
  lt(e, t) {
    return this.setLimit("max", e, false, F.toString(t));
  }
  setLimit(e, t, r, o) {
    return new _qi({ ...this._def, checks: [...this._def.checks, { kind: e, value: t, inclusive: r, message: F.toString(o) }] });
  }
  _addCheck(e) {
    return new _qi({ ...this._def, checks: [...this._def.checks, e] });
  }
  int(e) {
    return this._addCheck({ kind: "int", message: F.toString(e) });
  }
  positive(e) {
    return this._addCheck({ kind: "min", value: 0, inclusive: false, message: F.toString(e) });
  }
  negative(e) {
    return this._addCheck({ kind: "max", value: 0, inclusive: false, message: F.toString(e) });
  }
  nonpositive(e) {
    return this._addCheck({ kind: "max", value: 0, inclusive: true, message: F.toString(e) });
  }
  nonnegative(e) {
    return this._addCheck({ kind: "min", value: 0, inclusive: true, message: F.toString(e) });
  }
  multipleOf(e, t) {
    return this._addCheck({ kind: "multipleOf", value: e, message: F.toString(t) });
  }
  finite(e) {
    return this._addCheck({ kind: "finite", message: F.toString(e) });
  }
  safe(e) {
    return this._addCheck({ kind: "min", inclusive: true, value: Number.MIN_SAFE_INTEGER, message: F.toString(e) })._addCheck({ kind: "max", inclusive: true, value: Number.MAX_SAFE_INTEGER, message: F.toString(e) });
  }
  get minValue() {
    let e = null;
    for (let t of this._def.checks) if (t.kind === "min") {
      if (e === null || t.value > e) e = t.value;
    }
    return e;
  }
  get maxValue() {
    let e = null;
    for (let t of this._def.checks) if (t.kind === "max") {
      if (e === null || t.value < e) e = t.value;
    }
    return e;
  }
  get isInt() {
    return !!this._def.checks.find((e) => e.kind === "int" || e.kind === "multipleOf" && ae.isInteger(e.value));
  }
  get isFinite() {
    let e = null, t = null;
    for (let r of this._def.checks) if (r.kind === "finite" || r.kind === "int" || r.kind === "multipleOf") return true;
    else if (r.kind === "min") {
      if (t === null || r.value > t) t = r.value;
    } else if (r.kind === "max") {
      if (e === null || r.value < e) e = r.value;
    }
    return Number.isFinite(t) && Number.isFinite(e);
  }
};
qi.create = (e) => new qi({ checks: [], typeName: R.ZodNumber, coerce: e?.coerce || false, ...Q(e) });
var Vi = class _Vi extends oe {
  constructor() {
    super(...arguments);
    this.min = this.gte, this.max = this.lte;
  }
  _parse(e) {
    if (this._def.coerce) try {
      e.data = BigInt(e.data);
    } catch {
      return this._getInvalidInput(e);
    }
    if (this._getType(e) !== C.bigint) return this._getInvalidInput(e);
    let r = void 0, o = new at();
    for (let n of this._def.checks) if (n.kind === "min") {
      if (n.inclusive ? e.data < n.value : e.data <= n.value) r = this._getOrReturnCtx(e, r), j(r, { code: I.too_small, type: "bigint", minimum: n.value, inclusive: n.inclusive, message: n.message }), o.dirty();
    } else if (n.kind === "max") {
      if (n.inclusive ? e.data > n.value : e.data >= n.value) r = this._getOrReturnCtx(e, r), j(r, { code: I.too_big, type: "bigint", maximum: n.value, inclusive: n.inclusive, message: n.message }), o.dirty();
    } else if (n.kind === "multipleOf") {
      if (e.data % n.value !== BigInt(0)) r = this._getOrReturnCtx(e, r), j(r, { code: I.not_multiple_of, multipleOf: n.value, message: n.message }), o.dirty();
    } else ae.assertNever(n);
    return { status: o.value, value: e.data };
  }
  _getInvalidInput(e) {
    let t = this._getOrReturnCtx(e);
    return j(t, { code: I.invalid_type, expected: C.bigint, received: t.parsedType }), W;
  }
  gte(e, t) {
    return this.setLimit("min", e, true, F.toString(t));
  }
  gt(e, t) {
    return this.setLimit("min", e, false, F.toString(t));
  }
  lte(e, t) {
    return this.setLimit("max", e, true, F.toString(t));
  }
  lt(e, t) {
    return this.setLimit("max", e, false, F.toString(t));
  }
  setLimit(e, t, r, o) {
    return new _Vi({ ...this._def, checks: [...this._def.checks, { kind: e, value: t, inclusive: r, message: F.toString(o) }] });
  }
  _addCheck(e) {
    return new _Vi({ ...this._def, checks: [...this._def.checks, e] });
  }
  positive(e) {
    return this._addCheck({ kind: "min", value: BigInt(0), inclusive: false, message: F.toString(e) });
  }
  negative(e) {
    return this._addCheck({ kind: "max", value: BigInt(0), inclusive: false, message: F.toString(e) });
  }
  nonpositive(e) {
    return this._addCheck({ kind: "max", value: BigInt(0), inclusive: true, message: F.toString(e) });
  }
  nonnegative(e) {
    return this._addCheck({ kind: "min", value: BigInt(0), inclusive: true, message: F.toString(e) });
  }
  multipleOf(e, t) {
    return this._addCheck({ kind: "multipleOf", value: e, message: F.toString(t) });
  }
  get minValue() {
    let e = null;
    for (let t of this._def.checks) if (t.kind === "min") {
      if (e === null || t.value > e) e = t.value;
    }
    return e;
  }
  get maxValue() {
    let e = null;
    for (let t of this._def.checks) if (t.kind === "max") {
      if (e === null || t.value < e) e = t.value;
    }
    return e;
  }
};
Vi.create = (e) => new Vi({ checks: [], typeName: R.ZodBigInt, coerce: e?.coerce ?? false, ...Q(e) });
var Hd = class extends oe {
  _parse(e) {
    if (this._def.coerce) e.data = Boolean(e.data);
    if (this._getType(e) !== C.boolean) {
      let r = this._getOrReturnCtx(e);
      return j(r, { code: I.invalid_type, expected: C.boolean, received: r.parsedType }), W;
    }
    return mt(e.data);
  }
};
Hd.create = (e) => new Hd({ typeName: R.ZodBoolean, coerce: e?.coerce || false, ...Q(e) });
var pc = class _pc extends oe {
  _parse(e) {
    if (this._def.coerce) e.data = new Date(e.data);
    if (this._getType(e) !== C.date) {
      let n = this._getOrReturnCtx(e);
      return j(n, { code: I.invalid_type, expected: C.date, received: n.parsedType }), W;
    }
    if (Number.isNaN(e.data.getTime())) {
      let n = this._getOrReturnCtx(e);
      return j(n, { code: I.invalid_date }), W;
    }
    let r = new at(), o = void 0;
    for (let n of this._def.checks) if (n.kind === "min") {
      if (e.data.getTime() < n.value) o = this._getOrReturnCtx(e, o), j(o, { code: I.too_small, message: n.message, inclusive: true, exact: false, minimum: n.value, type: "date" }), r.dirty();
    } else if (n.kind === "max") {
      if (e.data.getTime() > n.value) o = this._getOrReturnCtx(e, o), j(o, { code: I.too_big, message: n.message, inclusive: true, exact: false, maximum: n.value, type: "date" }), r.dirty();
    } else ae.assertNever(n);
    return { status: r.value, value: new Date(e.data.getTime()) };
  }
  _addCheck(e) {
    return new _pc({ ...this._def, checks: [...this._def.checks, e] });
  }
  min(e, t) {
    return this._addCheck({ kind: "min", value: e.getTime(), message: F.toString(t) });
  }
  max(e, t) {
    return this._addCheck({ kind: "max", value: e.getTime(), message: F.toString(t) });
  }
  get minDate() {
    let e = null;
    for (let t of this._def.checks) if (t.kind === "min") {
      if (e === null || t.value > e) e = t.value;
    }
    return e != null ? new Date(e) : null;
  }
  get maxDate() {
    let e = null;
    for (let t of this._def.checks) if (t.kind === "max") {
      if (e === null || t.value < e) e = t.value;
    }
    return e != null ? new Date(e) : null;
  }
};
pc.create = (e) => new pc({ checks: [], coerce: e?.coerce || false, typeName: R.ZodDate, ...Q(e) });
var Bd = class extends oe {
  _parse(e) {
    if (this._getType(e) !== C.symbol) {
      let r = this._getOrReturnCtx(e);
      return j(r, { code: I.invalid_type, expected: C.symbol, received: r.parsedType }), W;
    }
    return mt(e.data);
  }
};
Bd.create = (e) => new Bd({ typeName: R.ZodSymbol, ...Q(e) });
var fc = class extends oe {
  _parse(e) {
    if (this._getType(e) !== C.undefined) {
      let r = this._getOrReturnCtx(e);
      return j(r, { code: I.invalid_type, expected: C.undefined, received: r.parsedType }), W;
    }
    return mt(e.data);
  }
};
fc.create = (e) => new fc({ typeName: R.ZodUndefined, ...Q(e) });
var mc = class extends oe {
  _parse(e) {
    if (this._getType(e) !== C.null) {
      let r = this._getOrReturnCtx(e);
      return j(r, { code: I.invalid_type, expected: C.null, received: r.parsedType }), W;
    }
    return mt(e.data);
  }
};
mc.create = (e) => new mc({ typeName: R.ZodNull, ...Q(e) });
var qd = class extends oe {
  constructor() {
    super(...arguments);
    this._any = true;
  }
  _parse(e) {
    return mt(e.data);
  }
};
qd.create = (e) => new qd({ typeName: R.ZodAny, ...Q(e) });
var Eo = class extends oe {
  constructor() {
    super(...arguments);
    this._unknown = true;
  }
  _parse(e) {
    return mt(e.data);
  }
};
Eo.create = (e) => new Eo({ typeName: R.ZodUnknown, ...Q(e) });
var Kr = class extends oe {
  _parse(e) {
    let t = this._getOrReturnCtx(e);
    return j(t, { code: I.invalid_type, expected: C.never, received: t.parsedType }), W;
  }
};
Kr.create = (e) => new Kr({ typeName: R.ZodNever, ...Q(e) });
var Vd = class extends oe {
  _parse(e) {
    if (this._getType(e) !== C.undefined) {
      let r = this._getOrReturnCtx(e);
      return j(r, { code: I.invalid_type, expected: C.void, received: r.parsedType }), W;
    }
    return mt(e.data);
  }
};
Vd.create = (e) => new Vd({ typeName: R.ZodVoid, ...Q(e) });
var Tr = class _Tr extends oe {
  _parse(e) {
    let { ctx: t, status: r } = this._processInputParams(e), o = this._def;
    if (t.parsedType !== C.array) return j(t, { code: I.invalid_type, expected: C.array, received: t.parsedType }), W;
    if (o.exactLength !== null) {
      let i = t.data.length > o.exactLength.value, s = t.data.length < o.exactLength.value;
      if (i || s) j(t, { code: i ? I.too_big : I.too_small, minimum: s ? o.exactLength.value : void 0, maximum: i ? o.exactLength.value : void 0, type: "array", inclusive: true, exact: true, message: o.exactLength.message }), r.dirty();
    }
    if (o.minLength !== null) {
      if (t.data.length < o.minLength.value) j(t, { code: I.too_small, minimum: o.minLength.value, type: "array", inclusive: true, exact: false, message: o.minLength.message }), r.dirty();
    }
    if (o.maxLength !== null) {
      if (t.data.length > o.maxLength.value) j(t, { code: I.too_big, maximum: o.maxLength.value, type: "array", inclusive: true, exact: false, message: o.maxLength.message }), r.dirty();
    }
    if (t.common.async) return Promise.all([...t.data].map((i, s) => o.type._parseAsync(new dr(t, i, t.path, s)))).then((i) => at.mergeArray(r, i));
    let n = [...t.data].map((i, s) => o.type._parseSync(new dr(t, i, t.path, s)));
    return at.mergeArray(r, n);
  }
  get element() {
    return this._def.type;
  }
  min(e, t) {
    return new _Tr({ ...this._def, minLength: { value: e, message: F.toString(t) } });
  }
  max(e, t) {
    return new _Tr({ ...this._def, maxLength: { value: e, message: F.toString(t) } });
  }
  length(e, t) {
    return new _Tr({ ...this._def, exactLength: { value: e, message: F.toString(t) } });
  }
  nonempty(e) {
    return this.min(1, e);
  }
};
Tr.create = (e, t) => new Tr({ type: e, minLength: null, maxLength: null, exactLength: null, typeName: R.ZodArray, ...Q(t) });
function Bi(e) {
  if (e instanceof ze) {
    let t = {};
    for (let r in e.shape) {
      let o = e.shape[r];
      t[r] = Xt.create(Bi(o));
    }
    return new ze({ ...e._def, shape: () => t });
  } else if (e instanceof Tr) return new Tr({ ...e._def, type: Bi(e.element) });
  else if (e instanceof Xt) return Xt.create(Bi(e.unwrap()));
  else if (e instanceof In) return In.create(Bi(e.unwrap()));
  else if (e instanceof Gr) return Gr.create(e.items.map((t) => Bi(t)));
  else return e;
}
var ze = class _ze extends oe {
  constructor() {
    super(...arguments);
    this._cached = null, this.nonstrict = this.passthrough, this.augment = this.extend;
  }
  _getCached() {
    if (this._cached !== null) return this._cached;
    let e = this._def.shape(), t = ae.objectKeys(e);
    return this._cached = { shape: e, keys: t }, this._cached;
  }
  _parse(e) {
    if (this._getType(e) !== C.object) {
      let c = this._getOrReturnCtx(e);
      return j(c, { code: I.invalid_type, expected: C.object, received: c.parsedType }), W;
    }
    let { status: r, ctx: o } = this._processInputParams(e), { shape: n, keys: i } = this._getCached(), s = [];
    if (!(this._def.catchall instanceof Kr && this._def.unknownKeys === "strip")) {
      for (let c in o.data) if (!i.includes(c)) s.push(c);
    }
    let a = [];
    for (let c of i) {
      let u = n[c], d = o.data[c];
      a.push({ key: { status: "valid", value: c }, value: u._parse(new dr(o, d, o.path, c)), alwaysSet: c in o.data });
    }
    if (this._def.catchall instanceof Kr) {
      let c = this._def.unknownKeys;
      if (c === "passthrough") for (let u of s) a.push({ key: { status: "valid", value: u }, value: { status: "valid", value: o.data[u] } });
      else if (c === "strict") {
        if (s.length > 0) j(o, { code: I.unrecognized_keys, keys: s }), r.dirty();
      } else if (c === "strip") ;
      else throw Error("Internal ZodObject error: invalid unknownKeys value.");
    } else {
      let c = this._def.catchall;
      for (let u of s) {
        let d = o.data[u];
        a.push({ key: { status: "valid", value: u }, value: c._parse(new dr(o, d, o.path, u)), alwaysSet: u in o.data });
      }
    }
    if (o.common.async) return Promise.resolve().then(async () => {
      let c = [];
      for (let u of a) {
        let d = await u.key, p = await u.value;
        c.push({ key: d, value: p, alwaysSet: u.alwaysSet });
      }
      return c;
    }).then((c) => at.mergeObjectSync(r, c));
    else return at.mergeObjectSync(r, a);
  }
  get shape() {
    return this._def.shape();
  }
  strict(e) {
    return F.errToObj, new _ze({ ...this._def, unknownKeys: "strict", ...e !== void 0 ? { errorMap: (t, r) => {
      let o = this._def.errorMap?.(t, r).message ?? r.defaultError;
      if (t.code === "unrecognized_keys") return { message: F.errToObj(e).message ?? o };
      return { message: o };
    } } : {} });
  }
  strip() {
    return new _ze({ ...this._def, unknownKeys: "strip" });
  }
  passthrough() {
    return new _ze({ ...this._def, unknownKeys: "passthrough" });
  }
  extend(e) {
    return new _ze({ ...this._def, shape: () => ({ ...this._def.shape(), ...e }) });
  }
  merge(e) {
    return new _ze({ unknownKeys: e._def.unknownKeys, catchall: e._def.catchall, shape: () => ({ ...this._def.shape(), ...e._def.shape() }), typeName: R.ZodObject });
  }
  setKey(e, t) {
    return this.augment({ [e]: t });
  }
  catchall(e) {
    return new _ze({ ...this._def, catchall: e });
  }
  pick(e) {
    let t = {};
    for (let r of ae.objectKeys(e)) if (e[r] && this.shape[r]) t[r] = this.shape[r];
    return new _ze({ ...this._def, shape: () => t });
  }
  omit(e) {
    let t = {};
    for (let r of ae.objectKeys(this.shape)) if (!e[r]) t[r] = this.shape[r];
    return new _ze({ ...this._def, shape: () => t });
  }
  deepPartial() {
    return Bi(this);
  }
  partial(e) {
    let t = {};
    for (let r of ae.objectKeys(this.shape)) {
      let o = this.shape[r];
      if (e && !e[r]) t[r] = o;
      else t[r] = o.optional();
    }
    return new _ze({ ...this._def, shape: () => t });
  }
  required(e) {
    let t = {};
    for (let r of ae.objectKeys(this.shape)) if (e && !e[r]) t[r] = this.shape[r];
    else {
      let n = this.shape[r];
      while (n instanceof Xt) n = n._def.innerType;
      t[r] = n;
    }
    return new _ze({ ...this._def, shape: () => t });
  }
  keyof() {
    return qR(ae.objectKeys(this.shape));
  }
};
ze.create = (e, t) => new ze({ shape: () => e, unknownKeys: "strip", catchall: Kr.create(), typeName: R.ZodObject, ...Q(t) });
ze.strictCreate = (e, t) => new ze({ shape: () => e, unknownKeys: "strict", catchall: Kr.create(), typeName: R.ZodObject, ...Q(t) });
ze.lazycreate = (e, t) => new ze({ shape: e, unknownKeys: "strip", catchall: Kr.create(), typeName: R.ZodObject, ...Q(t) });
var gc = class extends oe {
  _parse(e) {
    let { ctx: t } = this._processInputParams(e), r = this._def.options;
    function o(n) {
      for (let s of n) if (s.result.status === "valid") return s.result;
      for (let s of n) if (s.result.status === "dirty") return t.common.issues.push(...s.ctx.common.issues), s.result;
      let i = n.map((s) => new jt(s.ctx.common.issues));
      return j(t, { code: I.invalid_union, unionErrors: i }), W;
    }
    if (t.common.async) return Promise.all(r.map(async (n) => {
      let i = { ...t, common: { ...t.common, issues: [] }, parent: null };
      return { result: await n._parseAsync({ data: t.data, path: t.path, parent: i }), ctx: i };
    })).then(o);
    else {
      let n = void 0, i = [];
      for (let a of r) {
        let c = { ...t, common: { ...t.common, issues: [] }, parent: null }, u = a._parseSync({ data: t.data, path: t.path, parent: c });
        if (u.status === "valid") return u;
        else if (u.status === "dirty" && !n) n = { result: u, ctx: c };
        if (c.common.issues.length) i.push(c.common.issues);
      }
      if (n) return t.common.issues.push(...n.ctx.common.issues), n.result;
      let s = i.map((a) => new jt(a));
      return j(t, { code: I.invalid_union, unionErrors: s }), W;
    }
  }
  get options() {
    return this._def.options;
  }
};
gc.create = (e, t) => new gc({ options: e, typeName: R.ZodUnion, ...Q(t) });
var Zr = (e) => {
  if (e instanceof yc) return Zr(e.schema);
  else if (e instanceof Ir) return Zr(e.innerType());
  else if (e instanceof bc) return [e.value];
  else if (e instanceof Po) return e.options;
  else if (e instanceof _c) return ae.objectValues(e.enum);
  else if (e instanceof vc) return Zr(e._def.innerType);
  else if (e instanceof fc) return [void 0];
  else if (e instanceof mc) return [null];
  else if (e instanceof Xt) return [void 0, ...Zr(e.unwrap())];
  else if (e instanceof In) return [null, ...Zr(e.unwrap())];
  else if (e instanceof rb) return Zr(e.unwrap());
  else if (e instanceof xc) return Zr(e.unwrap());
  else if (e instanceof Sc) return Zr(e._def.innerType);
  else return [];
};
var tb = class _tb extends oe {
  _parse(e) {
    let { ctx: t } = this._processInputParams(e);
    if (t.parsedType !== C.object) return j(t, { code: I.invalid_type, expected: C.object, received: t.parsedType }), W;
    let r = this.discriminator, o = t.data[r], n = this.optionsMap.get(o);
    if (!n) return j(t, { code: I.invalid_union_discriminator, options: Array.from(this.optionsMap.keys()), path: [r] }), W;
    if (t.common.async) return n._parseAsync({ data: t.data, path: t.path, parent: t });
    else return n._parseSync({ data: t.data, path: t.path, parent: t });
  }
  get discriminator() {
    return this._def.discriminator;
  }
  get options() {
    return this._def.options;
  }
  get optionsMap() {
    return this._def.optionsMap;
  }
  static create(e, t, r) {
    let o = /* @__PURE__ */ new Map();
    for (let n of t) {
      let i = Zr(n.shape[e]);
      if (!i.length) throw Error(`A discriminator value for key \`${e}\` could not be extracted from all schema options`);
      for (let s of i) {
        if (o.has(s)) throw Error(`Discriminator property ${String(e)} has duplicate value ${String(s)}`);
        o.set(s, n);
      }
    }
    return new _tb({ typeName: R.ZodDiscriminatedUnion, discriminator: e, options: t, optionsMap: o, ...Q(r) });
  }
};
function eb(e, t) {
  let r = Vr(e), o = Vr(t);
  if (e === t) return { valid: true, data: e };
  else if (r === C.object && o === C.object) {
    let n = ae.objectKeys(t), i = ae.objectKeys(e).filter((a) => n.indexOf(a) !== -1), s = { ...e, ...t };
    for (let a of i) {
      let c = eb(e[a], t[a]);
      if (!c.valid) return { valid: false };
      s[a] = c.data;
    }
    return { valid: true, data: s };
  } else if (r === C.array && o === C.array) {
    if (e.length !== t.length) return { valid: false };
    let n = [];
    for (let i = 0; i < e.length; i++) {
      let s = e[i], a = t[i], c = eb(s, a);
      if (!c.valid) return { valid: false };
      n.push(c.data);
    }
    return { valid: true, data: n };
  } else if (r === C.date && o === C.date && +e === +t) return { valid: true, data: e };
  else return { valid: false };
}
var hc = class extends oe {
  _parse(e) {
    let { status: t, ctx: r } = this._processInputParams(e), o = (n, i) => {
      if (Xy(n) || Xy(i)) return W;
      let s = eb(n.value, i.value);
      if (!s.valid) return j(r, { code: I.invalid_intersection_types }), W;
      if (Yy(n) || Yy(i)) t.dirty();
      return { status: t.value, value: s.data };
    };
    if (r.common.async) return Promise.all([this._def.left._parseAsync({ data: r.data, path: r.path, parent: r }), this._def.right._parseAsync({ data: r.data, path: r.path, parent: r })]).then(([n, i]) => o(n, i));
    else return o(this._def.left._parseSync({ data: r.data, path: r.path, parent: r }), this._def.right._parseSync({ data: r.data, path: r.path, parent: r }));
  }
};
hc.create = (e, t, r) => new hc({ left: e, right: t, typeName: R.ZodIntersection, ...Q(r) });
var Gr = class _Gr extends oe {
  _parse(e) {
    let { status: t, ctx: r } = this._processInputParams(e);
    if (r.parsedType !== C.array) return j(r, { code: I.invalid_type, expected: C.array, received: r.parsedType }), W;
    if (r.data.length < this._def.items.length) return j(r, { code: I.too_small, minimum: this._def.items.length, inclusive: true, exact: false, type: "array" }), W;
    if (!this._def.rest && r.data.length > this._def.items.length) j(r, { code: I.too_big, maximum: this._def.items.length, inclusive: true, exact: false, type: "array" }), t.dirty();
    let n = [...r.data].map((i, s) => {
      let a = this._def.items[s] || this._def.rest;
      if (!a) return null;
      return a._parse(new dr(r, i, r.path, s));
    }).filter((i) => !!i);
    if (r.common.async) return Promise.all(n).then((i) => at.mergeArray(t, i));
    else return at.mergeArray(t, n);
  }
  get items() {
    return this._def.items;
  }
  rest(e) {
    return new _Gr({ ...this._def, rest: e });
  }
};
Gr.create = (e, t) => {
  if (!Array.isArray(e)) throw Error("You must pass an array of schemas to z.tuple([ ... ])");
  return new Gr({ items: e, typeName: R.ZodTuple, rest: null, ...Q(t) });
};
var Zd = class _Zd extends oe {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(e) {
    let { status: t, ctx: r } = this._processInputParams(e);
    if (r.parsedType !== C.object) return j(r, { code: I.invalid_type, expected: C.object, received: r.parsedType }), W;
    let o = [], n = this._def.keyType, i = this._def.valueType;
    for (let s in r.data) o.push({ key: n._parse(new dr(r, s, r.path, s)), value: i._parse(new dr(r, r.data[s], r.path, s)), alwaysSet: s in r.data });
    if (r.common.async) return at.mergeObjectAsync(t, o);
    else return at.mergeObjectSync(t, o);
  }
  get element() {
    return this._def.valueType;
  }
  static create(e, t, r) {
    if (t instanceof oe) return new _Zd({ keyType: e, valueType: t, typeName: R.ZodRecord, ...Q(r) });
    return new _Zd({ keyType: Wr.create(), valueType: e, typeName: R.ZodRecord, ...Q(t) });
  }
};
var Wd = class extends oe {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(e) {
    let { status: t, ctx: r } = this._processInputParams(e);
    if (r.parsedType !== C.map) return j(r, { code: I.invalid_type, expected: C.map, received: r.parsedType }), W;
    let o = this._def.keyType, n = this._def.valueType, i = [...r.data.entries()].map(([s, a], c) => ({ key: o._parse(new dr(r, s, r.path, [c, "key"])), value: n._parse(new dr(r, a, r.path, [c, "value"])) }));
    if (r.common.async) {
      let s = /* @__PURE__ */ new Map();
      return Promise.resolve().then(async () => {
        for (let a of i) {
          let c = await a.key, u = await a.value;
          if (c.status === "aborted" || u.status === "aborted") return W;
          if (c.status === "dirty" || u.status === "dirty") t.dirty();
          s.set(c.value, u.value);
        }
        return { status: t.value, value: s };
      });
    } else {
      let s = /* @__PURE__ */ new Map();
      for (let a of i) {
        let { key: c, value: u } = a;
        if (c.status === "aborted" || u.status === "aborted") return W;
        if (c.status === "dirty" || u.status === "dirty") t.dirty();
        s.set(c.value, u.value);
      }
      return { status: t.value, value: s };
    }
  }
};
Wd.create = (e, t, r) => new Wd({ valueType: t, keyType: e, typeName: R.ZodMap, ...Q(r) });
var Zi = class _Zi extends oe {
  _parse(e) {
    let { status: t, ctx: r } = this._processInputParams(e);
    if (r.parsedType !== C.set) return j(r, { code: I.invalid_type, expected: C.set, received: r.parsedType }), W;
    let o = this._def;
    if (o.minSize !== null) {
      if (r.data.size < o.minSize.value) j(r, { code: I.too_small, minimum: o.minSize.value, type: "set", inclusive: true, exact: false, message: o.minSize.message }), t.dirty();
    }
    if (o.maxSize !== null) {
      if (r.data.size > o.maxSize.value) j(r, { code: I.too_big, maximum: o.maxSize.value, type: "set", inclusive: true, exact: false, message: o.maxSize.message }), t.dirty();
    }
    let n = this._def.valueType;
    function i(a) {
      let c = /* @__PURE__ */ new Set();
      for (let u of a) {
        if (u.status === "aborted") return W;
        if (u.status === "dirty") t.dirty();
        c.add(u.value);
      }
      return { status: t.value, value: c };
    }
    let s = [...r.data.values()].map((a, c) => n._parse(new dr(r, a, r.path, c)));
    if (r.common.async) return Promise.all(s).then((a) => i(a));
    else return i(s);
  }
  min(e, t) {
    return new _Zi({ ...this._def, minSize: { value: e, message: F.toString(t) } });
  }
  max(e, t) {
    return new _Zi({ ...this._def, maxSize: { value: e, message: F.toString(t) } });
  }
  size(e, t) {
    return this.min(e, t).max(e, t);
  }
  nonempty(e) {
    return this.min(1, e);
  }
};
Zi.create = (e, t) => new Zi({ valueType: e, minSize: null, maxSize: null, typeName: R.ZodSet, ...Q(t) });
var dc = class _dc extends oe {
  constructor() {
    super(...arguments);
    this.validate = this.implement;
  }
  _parse(e) {
    let { ctx: t } = this._processInputParams(e);
    if (t.parsedType !== C.function) return j(t, { code: I.invalid_type, expected: C.function, received: t.parsedType }), W;
    function r(s, a) {
      return Fd({ data: s, path: t.path, errorMaps: [t.common.contextualErrorMap, t.schemaErrorMap, lc(), Tn].filter((c) => !!c), issueData: { code: I.invalid_arguments, argumentsError: a } });
    }
    function o(s, a) {
      return Fd({ data: s, path: t.path, errorMaps: [t.common.contextualErrorMap, t.schemaErrorMap, lc(), Tn].filter((c) => !!c), issueData: { code: I.invalid_return_type, returnTypeError: a } });
    }
    let n = { errorMap: t.common.contextualErrorMap }, i = t.data;
    if (this._def.returns instanceof Wi) {
      let s = this;
      return mt(async function(...a) {
        let c = new jt([]), u = await s._def.args.parseAsync(a, n).catch((f) => {
          throw c.addIssue(r(a, f)), c;
        }), d = await Reflect.apply(i, this, u);
        return await s._def.returns._def.type.parseAsync(d, n).catch((f) => {
          throw c.addIssue(o(d, f)), c;
        });
      });
    } else {
      let s = this;
      return mt(function(...a) {
        let c = s._def.args.safeParse(a, n);
        if (!c.success) throw new jt([r(a, c.error)]);
        let u = Reflect.apply(i, this, c.data), d = s._def.returns.safeParse(u, n);
        if (!d.success) throw new jt([o(u, d.error)]);
        return d.data;
      });
    }
  }
  parameters() {
    return this._def.args;
  }
  returnType() {
    return this._def.returns;
  }
  args(...e) {
    return new _dc({ ...this._def, args: Gr.create(e).rest(Eo.create()) });
  }
  returns(e) {
    return new _dc({ ...this._def, returns: e });
  }
  implement(e) {
    return this.parse(e);
  }
  strictImplement(e) {
    return this.parse(e);
  }
  static create(e, t, r) {
    return new _dc({ args: e ? e : Gr.create([]).rest(Eo.create()), returns: t || Eo.create(), typeName: R.ZodFunction, ...Q(r) });
  }
};
var yc = class extends oe {
  get schema() {
    return this._def.getter();
  }
  _parse(e) {
    let { ctx: t } = this._processInputParams(e);
    return this._def.getter()._parse({ data: t.data, path: t.path, parent: t });
  }
};
yc.create = (e, t) => new yc({ getter: e, typeName: R.ZodLazy, ...Q(t) });
var bc = class extends oe {
  _parse(e) {
    if (e.data !== this._def.value) {
      let t = this._getOrReturnCtx(e);
      return j(t, { received: t.data, code: I.invalid_literal, expected: this._def.value }), W;
    }
    return { status: "valid", value: e.data };
  }
  get value() {
    return this._def.value;
  }
};
bc.create = (e, t) => new bc({ value: e, typeName: R.ZodLiteral, ...Q(t) });
function qR(e, t) {
  return new Po({ values: e, typeName: R.ZodEnum, ...Q(t) });
}
var Po = class _Po extends oe {
  _parse(e) {
    if (typeof e.data !== "string") {
      let t = this._getOrReturnCtx(e), r = this._def.values;
      return j(t, { expected: ae.joinValues(r), received: t.parsedType, code: I.invalid_type }), W;
    }
    if (!this._cache) this._cache = new Set(this._def.values);
    if (!this._cache.has(e.data)) {
      let t = this._getOrReturnCtx(e), r = this._def.values;
      return j(t, { received: t.data, code: I.invalid_enum_value, options: r }), W;
    }
    return mt(e.data);
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    let e = {};
    for (let t of this._def.values) e[t] = t;
    return e;
  }
  get Values() {
    let e = {};
    for (let t of this._def.values) e[t] = t;
    return e;
  }
  get Enum() {
    let e = {};
    for (let t of this._def.values) e[t] = t;
    return e;
  }
  extract(e, t = this._def) {
    return _Po.create(e, { ...this._def, ...t });
  }
  exclude(e, t = this._def) {
    return _Po.create(this.options.filter((r) => !e.includes(r)), { ...this._def, ...t });
  }
};
Po.create = qR;
var _c = class extends oe {
  _parse(e) {
    let t = ae.getValidEnumValues(this._def.values), r = this._getOrReturnCtx(e);
    if (r.parsedType !== C.string && r.parsedType !== C.number) {
      let o = ae.objectValues(t);
      return j(r, { expected: ae.joinValues(o), received: r.parsedType, code: I.invalid_type }), W;
    }
    if (!this._cache) this._cache = new Set(ae.getValidEnumValues(this._def.values));
    if (!this._cache.has(e.data)) {
      let o = ae.objectValues(t);
      return j(r, { received: r.data, code: I.invalid_enum_value, options: o }), W;
    }
    return mt(e.data);
  }
  get enum() {
    return this._def.values;
  }
};
_c.create = (e, t) => new _c({ values: e, typeName: R.ZodNativeEnum, ...Q(t) });
var Wi = class extends oe {
  unwrap() {
    return this._def.type;
  }
  _parse(e) {
    let { ctx: t } = this._processInputParams(e);
    if (t.parsedType !== C.promise && t.common.async === false) return j(t, { code: I.invalid_type, expected: C.promise, received: t.parsedType }), W;
    let r = t.parsedType === C.promise ? t.data : Promise.resolve(t.data);
    return mt(r.then((o) => this._def.type.parseAsync(o, { path: t.path, errorMap: t.common.contextualErrorMap })));
  }
};
Wi.create = (e, t) => new Wi({ type: e, typeName: R.ZodPromise, ...Q(t) });
var Ir = class extends oe {
  innerType() {
    return this._def.schema;
  }
  sourceType() {
    return this._def.schema._def.typeName === R.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
  }
  _parse(e) {
    let { status: t, ctx: r } = this._processInputParams(e), o = this._def.effect || null, n = { addIssue: (i) => {
      if (j(r, i), i.fatal) t.abort();
      else t.dirty();
    }, get path() {
      return r.path;
    } };
    if (n.addIssue = n.addIssue.bind(n), o.type === "preprocess") {
      let i = o.transform(r.data, n);
      if (r.common.async) return Promise.resolve(i).then(async (s) => {
        if (t.value === "aborted") return W;
        let a = await this._def.schema._parseAsync({ data: s, path: r.path, parent: r });
        if (a.status === "aborted") return W;
        if (a.status === "dirty") return Hi(a.value);
        if (t.value === "dirty") return Hi(a.value);
        return a;
      });
      else {
        if (t.value === "aborted") return W;
        let s = this._def.schema._parseSync({ data: i, path: r.path, parent: r });
        if (s.status === "aborted") return W;
        if (s.status === "dirty") return Hi(s.value);
        if (t.value === "dirty") return Hi(s.value);
        return s;
      }
    }
    if (o.type === "refinement") {
      let i = (s) => {
        let a = o.refinement(s, n);
        if (r.common.async) return Promise.resolve(a);
        if (a instanceof Promise) throw Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
        return s;
      };
      if (r.common.async === false) {
        let s = this._def.schema._parseSync({ data: r.data, path: r.path, parent: r });
        if (s.status === "aborted") return W;
        if (s.status === "dirty") t.dirty();
        return i(s.value), { status: t.value, value: s.value };
      } else return this._def.schema._parseAsync({ data: r.data, path: r.path, parent: r }).then((s) => {
        if (s.status === "aborted") return W;
        if (s.status === "dirty") t.dirty();
        return i(s.value).then(() => ({ status: t.value, value: s.value }));
      });
    }
    if (o.type === "transform") if (r.common.async === false) {
      let i = this._def.schema._parseSync({ data: r.data, path: r.path, parent: r });
      if (!ko(i)) return W;
      let s = o.transform(i.value, n);
      if (s instanceof Promise) throw Error("Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.");
      return { status: t.value, value: s };
    } else return this._def.schema._parseAsync({ data: r.data, path: r.path, parent: r }).then((i) => {
      if (!ko(i)) return W;
      return Promise.resolve(o.transform(i.value, n)).then((s) => ({ status: t.value, value: s }));
    });
    ae.assertNever(o);
  }
};
Ir.create = (e, t, r) => new Ir({ schema: e, typeName: R.ZodEffects, effect: t, ...Q(r) });
Ir.createWithPreprocess = (e, t, r) => new Ir({ schema: t, effect: { type: "preprocess", transform: e }, typeName: R.ZodEffects, ...Q(r) });
var Xt = class extends oe {
  _parse(e) {
    if (this._getType(e) === C.undefined) return mt(void 0);
    return this._def.innerType._parse(e);
  }
  unwrap() {
    return this._def.innerType;
  }
};
Xt.create = (e, t) => new Xt({ innerType: e, typeName: R.ZodOptional, ...Q(t) });
var In = class extends oe {
  _parse(e) {
    if (this._getType(e) === C.null) return mt(null);
    return this._def.innerType._parse(e);
  }
  unwrap() {
    return this._def.innerType;
  }
};
In.create = (e, t) => new In({ innerType: e, typeName: R.ZodNullable, ...Q(t) });
var vc = class extends oe {
  _parse(e) {
    let { ctx: t } = this._processInputParams(e), r = t.data;
    if (t.parsedType === C.undefined) r = this._def.defaultValue();
    return this._def.innerType._parse({ data: r, path: t.path, parent: t });
  }
  removeDefault() {
    return this._def.innerType;
  }
};
vc.create = (e, t) => new vc({ innerType: e, typeName: R.ZodDefault, defaultValue: typeof t.default === "function" ? t.default : () => t.default, ...Q(t) });
var Sc = class extends oe {
  _parse(e) {
    let { ctx: t } = this._processInputParams(e), r = { ...t, common: { ...t.common, issues: [] } }, o = this._def.innerType._parse({ data: r.data, path: r.path, parent: { ...r } });
    if (uc(o)) return o.then((n) => ({ status: "valid", value: n.status === "valid" ? n.value : this._def.catchValue({ get error() {
      return new jt(r.common.issues);
    }, input: r.data }) }));
    else return { status: "valid", value: o.status === "valid" ? o.value : this._def.catchValue({ get error() {
      return new jt(r.common.issues);
    }, input: r.data }) };
  }
  removeCatch() {
    return this._def.innerType;
  }
};
Sc.create = (e, t) => new Sc({ innerType: e, typeName: R.ZodCatch, catchValue: typeof t.catch === "function" ? t.catch : () => t.catch, ...Q(t) });
var Kd = class extends oe {
  _parse(e) {
    if (this._getType(e) !== C.nan) {
      let r = this._getOrReturnCtx(e);
      return j(r, { code: I.invalid_type, expected: C.nan, received: r.parsedType }), W;
    }
    return { status: "valid", value: e.data };
  }
};
Kd.create = (e) => new Kd({ typeName: R.ZodNaN, ...Q(e) });
var z_e = Symbol("zod_brand");
var rb = class extends oe {
  _parse(e) {
    let { ctx: t } = this._processInputParams(e), r = t.data;
    return this._def.type._parse({ data: r, path: t.path, parent: t });
  }
  unwrap() {
    return this._def.type;
  }
};
var Gd = class _Gd extends oe {
  _parse(e) {
    let { status: t, ctx: r } = this._processInputParams(e);
    if (r.common.async) return (async () => {
      let n = await this._def.in._parseAsync({ data: r.data, path: r.path, parent: r });
      if (n.status === "aborted") return W;
      if (n.status === "dirty") return t.dirty(), Hi(n.value);
      else return this._def.out._parseAsync({ data: n.value, path: r.path, parent: r });
    })();
    else {
      let o = this._def.in._parseSync({ data: r.data, path: r.path, parent: r });
      if (o.status === "aborted") return W;
      if (o.status === "dirty") return t.dirty(), { status: "dirty", value: o.value };
      else return this._def.out._parseSync({ data: o.value, path: r.path, parent: r });
    }
  }
  static create(e, t) {
    return new _Gd({ in: e, out: t, typeName: R.ZodPipeline });
  }
};
var xc = class extends oe {
  _parse(e) {
    let t = this._def.innerType._parse(e), r = (o) => {
      if (ko(o)) o.value = Object.freeze(o.value);
      return o;
    };
    return uc(t) ? t.then((o) => r(o)) : r(t);
  }
  unwrap() {
    return this._def.innerType;
  }
};
xc.create = (e, t) => new xc({ innerType: e, typeName: R.ZodReadonly, ...Q(t) });
var L_e = { object: ze.lazycreate };
var R;
(function(e) {
  e.ZodString = "ZodString", e.ZodNumber = "ZodNumber", e.ZodNaN = "ZodNaN", e.ZodBigInt = "ZodBigInt", e.ZodBoolean = "ZodBoolean", e.ZodDate = "ZodDate", e.ZodSymbol = "ZodSymbol", e.ZodUndefined = "ZodUndefined", e.ZodNull = "ZodNull", e.ZodAny = "ZodAny", e.ZodUnknown = "ZodUnknown", e.ZodNever = "ZodNever", e.ZodVoid = "ZodVoid", e.ZodArray = "ZodArray", e.ZodObject = "ZodObject", e.ZodUnion = "ZodUnion", e.ZodDiscriminatedUnion = "ZodDiscriminatedUnion", e.ZodIntersection = "ZodIntersection", e.ZodTuple = "ZodTuple", e.ZodRecord = "ZodRecord", e.ZodMap = "ZodMap", e.ZodSet = "ZodSet", e.ZodFunction = "ZodFunction", e.ZodLazy = "ZodLazy", e.ZodLiteral = "ZodLiteral", e.ZodEnum = "ZodEnum", e.ZodEffects = "ZodEffects", e.ZodNativeEnum = "ZodNativeEnum", e.ZodOptional = "ZodOptional", e.ZodNullable = "ZodNullable", e.ZodDefault = "ZodDefault", e.ZodCatch = "ZodCatch", e.ZodPromise = "ZodPromise", e.ZodBranded = "ZodBranded", e.ZodPipeline = "ZodPipeline", e.ZodReadonly = "ZodReadonly";
})(R || (R = {}));
var F_e = Wr.create;
var H_e = qi.create;
var B_e = Kd.create;
var q_e = Vi.create;
var V_e = Hd.create;
var Z_e = pc.create;
var W_e = Bd.create;
var K_e = fc.create;
var G_e = mc.create;
var J_e = qd.create;
var X_e = Eo.create;
var Y_e = Kr.create;
var Q_e = Vd.create;
var eve = Tr.create;
var VR = ze.create;
var tve = ze.strictCreate;
var rve = gc.create;
var nve = tb.create;
var ove = hc.create;
var ive = Gr.create;
var sve = Zd.create;
var ave = Wd.create;
var cve = Zi.create;
var lve = dc.create;
var uve = yc.create;
var dve = bc.create;
var pve = Po.create;
var fve = _c.create;
var mve = Wi.create;
var gve = Ir.create;
var hve = Xt.create;
var yve = In.create;
var bve = Ir.createWithPreprocess;
var _ve = Gd.create;
var pr = {};
kr(pr, { version: () => s_, util: () => O, treeifyError: () => Qd, toJSONSchema: () => ls, toDotPath: () => KR, safeParseAsync: () => An, safeParse: () => $n, registry: () => Uc, regexes: () => On, prettifyError: () => ep, parseAsync: () => $o, parse: () => Ro, locales: () => os, isValidJWT: () => p$, isValidBase64URL: () => d$, isValidBase64: () => p_, globalRegistry: () => Et, globalConfig: () => wc, function: () => Df, formatError: () => Yi, flattenError: () => Xi, config: () => Be, clone: () => ct, _xid: () => Jc, _void: () => Tf, _uuidv7: () => Bc, _uuidv6: () => Hc, _uuidv4: () => Fc, _uuid: () => Lc, _url: () => qc, _uppercase: () => ll, _unknown: () => Co, _union: () => kW, _undefined: () => wf, _ulid: () => Gc, _uint64: () => Sf, _uint32: () => yf, _tuple: () => dv, _trim: () => gl, _transform: () => CW, _toUpperCase: () => yl, _toLowerCase: () => hl, _templateLiteral: () => HW, _symbol: () => xf, _success: () => UW, _stringbool: () => Cf, _stringFormat: () => Mf, _string: () => uf, _startsWith: () => dl, _size: () => sl, _set: () => RW, _safeParseAsync: () => op, _safeParse: () => np, _regex: () => al, _refine: () => Of, _record: () => TW, _readonly: () => FW, _property: () => uv, _promise: () => qW, _positive: () => sv, _pipe: () => LW, _parseAsync: () => rp, _parse: () => tp, _overwrite: () => en, _optional: () => MW, _number: () => pf, _nullable: () => DW, _null: () => kf, _normalize: () => ml, _nonpositive: () => cv, _nonoptional: () => jW, _nonnegative: () => lv, _never: () => Pf, _negative: () => av, _nativeEnum: () => AW, _nanoid: () => Zc, _nan: () => Rf, _multipleOf: () => Mo, _minSize: () => Do, _minLength: () => Dn, _min: () => Pt, _mime: () => fl, _maxSize: () => ss, _maxLength: () => as, _max: () => Yt, _map: () => IW, _lte: () => Yt, _lt: () => Yr, _lowercase: () => cl, _literal: () => OW, _length: () => cs, _lazy: () => BW, _ksuid: () => Xc, _jwt: () => il, _isoTime: () => ev, _isoDuration: () => tv, _isoDateTime: () => Y_, _isoDate: () => Q_, _ipv6: () => Qc, _ipv4: () => Yc, _intersection: () => PW, _int64: () => vf, _int32: () => hf, _int: () => ff, _includes: () => ul, _guid: () => is, _gte: () => Pt, _gt: () => Qr, _float64: () => gf, _float32: () => mf, _file: () => $f, _enum: () => $W, _endsWith: () => pl, _emoji: () => Vc, _email: () => zc, _e164: () => ol, _discriminatedUnion: () => EW, _default: () => NW, _date: () => If, _custom: () => Af, _cuid2: () => Kc, _cuid: () => Wc, _coercedString: () => X_, _coercedNumber: () => rv, _coercedDate: () => iv, _coercedBoolean: () => nv, _coercedBigint: () => ov, _cidrv6: () => tl, _cidrv4: () => el, _catch: () => zW, _boolean: () => bf, _bigint: () => _f, _base64url: () => nl, _base64: () => rl, _array: () => bl, _any: () => Ef, TimePrecision: () => df, NEVER: () => Jd, JSONSchemaGenerator: () => Nf, JSONSchema: () => h$, Doc: () => cp, $output: () => cf, $input: () => lf, $constructor: () => b, $brand: () => Xd, $ZodXID: () => vp, $ZodVoid: () => Up, $ZodUnknown: () => Oo, $ZodUnion: () => Dc, $ZodUndefined: () => Mp, $ZodUUID: () => pp, $ZodURL: () => mp, $ZodULID: () => _p, $ZodType: () => G, $ZodTuple: () => Mn, $ZodTransform: () => rs, $ZodTemplateLiteral: () => nf, $ZodSymbol: () => Cp, $ZodSuccess: () => Qp, $ZodStringFormat: () => xe, $ZodString: () => Cn, $ZodSet: () => qp, $ZodRegistry: () => jc, $ZodRecord: () => Hp, $ZodRealError: () => Ji, $ZodReadonly: () => rf, $ZodPromise: () => of, $ZodPrefault: () => Xp, $ZodPipe: () => ns, $ZodOptional: () => Kp, $ZodObject: () => Mc, $ZodNumberFormat: () => Ap, $ZodNumber: () => Oc, $ZodNullable: () => Gp, $ZodNull: () => Dp, $ZodNonOptional: () => Yp, $ZodNever: () => jp, $ZodNanoID: () => hp, $ZodNaN: () => tf, $ZodMap: () => Bp, $ZodLiteral: () => Zp, $ZodLazy: () => sf, $ZodKSUID: () => Sp, $ZodJWT: () => Rp, $ZodIntersection: () => Fp, $ZodISOTime: () => u_, $ZodISODuration: () => d_, $ZodISODateTime: () => c_, $ZodISODate: () => l_, $ZodIPv6: () => wp, $ZodIPv4: () => xp, $ZodGUID: () => dp, $ZodFunction: () => pv, $ZodFile: () => Wp, $ZodError: () => Ac, $ZodEnum: () => Vp, $ZodEmoji: () => gp, $ZodEmail: () => fp, $ZodE164: () => Ip, $ZodDiscriminatedUnion: () => Lp, $ZodDefault: () => Jp, $ZodDate: () => zp, $ZodCustomStringFormat: () => $p, $ZodCustom: () => af, $ZodCheckUpperCase: () => Qb, $ZodCheckStringFormat: () => Qi, $ZodCheckStartsWith: () => t_, $ZodCheckSizeEquals: () => Wb, $ZodCheckRegex: () => Xb, $ZodCheckProperty: () => n_, $ZodCheckOverwrite: () => i_, $ZodCheckNumberFormat: () => Bb, $ZodCheckMultipleOf: () => Hb, $ZodCheckMinSize: () => Zb, $ZodCheckMinLength: () => Gb, $ZodCheckMimeType: () => o_, $ZodCheckMaxSize: () => Vb, $ZodCheckMaxLength: () => Kb, $ZodCheckLowerCase: () => Yb, $ZodCheckLessThan: () => sp, $ZodCheckLengthEquals: () => Jb, $ZodCheckIncludes: () => e_, $ZodCheckGreaterThan: () => ap, $ZodCheckEndsWith: () => r_, $ZodCheckBigIntFormat: () => qb, $ZodCheck: () => Me, $ZodCatch: () => ef, $ZodCUID2: () => bp, $ZodCUID: () => yp, $ZodCIDRv6: () => Ep, $ZodCIDRv4: () => kp, $ZodBoolean: () => es, $ZodBigIntFormat: () => Op, $ZodBigInt: () => Cc, $ZodBase64URL: () => Tp, $ZodBase64: () => Pp, $ZodAsyncError: () => Jr, $ZodArray: () => ts, $ZodAny: () => Np });
var Jd = Object.freeze({ status: "aborted" });
function b(e, t, r) {
  function o(a, c) {
    var u;
    Object.defineProperty(a, "_zod", { value: a._zod ?? {}, enumerable: false }), (u = a._zod).traits ?? (u.traits = /* @__PURE__ */ new Set()), a._zod.traits.add(e), t(a, c);
    for (let d in s.prototype) if (!(d in a)) Object.defineProperty(a, d, { value: s.prototype[d].bind(a) });
    a._zod.constr = s, a._zod.def = c;
  }
  let n = r?.Parent ?? Object;
  class i extends n {
  }
  Object.defineProperty(i, "name", { value: e });
  function s(a) {
    var c;
    let u = r?.Parent ? new i() : this;
    o(u, a), (c = u._zod).deferred ?? (c.deferred = []);
    for (let d of u._zod.deferred) d();
    return u;
  }
  return Object.defineProperty(s, "init", { value: o }), Object.defineProperty(s, Symbol.hasInstance, { value: (a) => {
    if (r?.Parent && a instanceof r.Parent) return true;
    return a?._zod?.traits?.has(e);
  } }), Object.defineProperty(s, "name", { value: e }), s;
}
var Xd = Symbol("zod_brand");
var Jr = class extends Error {
  constructor() {
    super("Encountered Promise during synchronous parse. Use .parseAsync() instead.");
  }
};
var wc = {};
function Be(e) {
  if (e) Object.assign(wc, e);
  return wc;
}
var O = {};
kr(O, { unwrapMessage: () => kc, stringifyPrimitive: () => D, required: () => wZ, randomString: () => mZ, propertyKeyTypes: () => Ic, promiseAllObject: () => fZ, primitiveTypes: () => cb, prefixIssues: () => kt, pick: () => bZ, partial: () => xZ, optionalKeys: () => lb, omit: () => _Z, numKeys: () => gZ, nullish: () => Rn, normalizeParams: () => A, merge: () => SZ, jsonStringifyReplacer: () => ob, joinValues: () => P, issue: () => pb, isPlainObject: () => Gi, isObject: () => Ki, getSizableOrigin: () => Rc, getParsedType: () => hZ, getLengthableOrigin: () => $c, getEnumValues: () => Ec, getElementAtPath: () => pZ, floatSafeRemainder: () => ib, finalizeIssue: () => Ut, extend: () => vZ, escapeRegex: () => Xr, esc: () => To, defineLazy: () => me, createTransparentProxy: () => yZ, clone: () => ct, cleanRegex: () => Tc, cleanEnum: () => kZ, captureStackTrace: () => Yd, cached: () => Pc, assignProp: () => sb, assertNotEqual: () => cZ, assertNever: () => uZ, assertIs: () => lZ, assertEqual: () => aZ, assert: () => dZ, allowsEval: () => ab, aborted: () => Io, NUMBER_FORMAT_RANGES: () => ub, Class: () => ZR, BIGINT_FORMAT_RANGES: () => db });
function aZ(e) {
  return e;
}
function cZ(e) {
  return e;
}
function lZ(e) {
}
function uZ(e) {
  throw Error();
}
function dZ(e) {
}
function Ec(e) {
  let t = Object.values(e).filter((o) => typeof o === "number");
  return Object.entries(e).filter(([o, n]) => t.indexOf(+o) === -1).map(([o, n]) => n);
}
function P(e, t = "|") {
  return e.map((r) => D(r)).join(t);
}
function ob(e, t) {
  if (typeof t === "bigint") return t.toString();
  return t;
}
function Pc(e) {
  return { get value() {
    {
      let r = e();
      return Object.defineProperty(this, "value", { value: r }), r;
    }
    throw Error("cached value already set");
  } };
}
function Rn(e) {
  return e === null || e === void 0;
}
function Tc(e) {
  let t = e.startsWith("^") ? 1 : 0, r = e.endsWith("$") ? e.length - 1 : e.length;
  return e.slice(t, r);
}
function ib(e, t) {
  let r = (e.toString().split(".")[1] || "").length, o = (t.toString().split(".")[1] || "").length, n = r > o ? r : o, i = Number.parseInt(e.toFixed(n).replace(".", "")), s = Number.parseInt(t.toFixed(n).replace(".", ""));
  return i % s / 10 ** n;
}
function me(e, t, r) {
  Object.defineProperty(e, t, { get() {
    {
      let n = r();
      return e[t] = n, n;
    }
    throw Error("cached value already set");
  }, set(n) {
    Object.defineProperty(e, t, { value: n });
  }, configurable: true });
}
function sb(e, t, r) {
  Object.defineProperty(e, t, { value: r, writable: true, enumerable: true, configurable: true });
}
function pZ(e, t) {
  if (!t) return e;
  return t.reduce((r, o) => r?.[o], e);
}
function fZ(e) {
  let t = Object.keys(e), r = t.map((o) => e[o]);
  return Promise.all(r).then((o) => {
    let n = {};
    for (let i = 0; i < t.length; i++) n[t[i]] = o[i];
    return n;
  });
}
function mZ(e = 10) {
  let r = "";
  for (let o = 0; o < e; o++) r += "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)];
  return r;
}
function To(e) {
  return JSON.stringify(e);
}
var Yd = Error.captureStackTrace ? Error.captureStackTrace : (...e) => {
};
function Ki(e) {
  return typeof e === "object" && e !== null && !Array.isArray(e);
}
var ab = Pc(() => {
  if (typeof navigator < "u" && navigator?.userAgent?.includes("Cloudflare")) return false;
  try {
    return new Function(""), true;
  } catch (e) {
    return false;
  }
});
function Gi(e) {
  if (Ki(e) === false) return false;
  let t = e.constructor;
  if (t === void 0) return true;
  let r = t.prototype;
  if (Ki(r) === false) return false;
  if (Object.prototype.hasOwnProperty.call(r, "isPrototypeOf") === false) return false;
  return true;
}
function gZ(e) {
  let t = 0;
  for (let r in e) if (Object.prototype.hasOwnProperty.call(e, r)) t++;
  return t;
}
var hZ = (e) => {
  let t = typeof e;
  switch (t) {
    case "undefined":
      return "undefined";
    case "string":
      return "string";
    case "number":
      return Number.isNaN(e) ? "nan" : "number";
    case "boolean":
      return "boolean";
    case "function":
      return "function";
    case "bigint":
      return "bigint";
    case "symbol":
      return "symbol";
    case "object":
      if (Array.isArray(e)) return "array";
      if (e === null) return "null";
      if (e.then && typeof e.then === "function" && e.catch && typeof e.catch === "function") return "promise";
      if (typeof Map < "u" && e instanceof Map) return "map";
      if (typeof Set < "u" && e instanceof Set) return "set";
      if (typeof Date < "u" && e instanceof Date) return "date";
      if (typeof File < "u" && e instanceof File) return "file";
      return "object";
    default:
      throw Error(`Unknown data type: ${t}`);
  }
};
var Ic = /* @__PURE__ */ new Set(["string", "number", "symbol"]);
var cb = /* @__PURE__ */ new Set(["string", "number", "bigint", "boolean", "symbol", "undefined"]);
function Xr(e) {
  return e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function ct(e, t, r) {
  let o = new e._zod.constr(t ?? e._zod.def);
  if (!t || r?.parent) o._zod.parent = e;
  return o;
}
function A(e) {
  let t = e;
  if (!t) return {};
  if (typeof t === "string") return { error: () => t };
  if (t?.message !== void 0) {
    if (t?.error !== void 0) throw Error("Cannot specify both `message` and `error` params");
    t.error = t.message;
  }
  if (delete t.message, typeof t.error === "string") return { ...t, error: () => t.error };
  return t;
}
function yZ(e) {
  let t;
  return new Proxy({}, { get(r, o, n) {
    return t ?? (t = e()), Reflect.get(t, o, n);
  }, set(r, o, n, i) {
    return t ?? (t = e()), Reflect.set(t, o, n, i);
  }, has(r, o) {
    return t ?? (t = e()), Reflect.has(t, o);
  }, deleteProperty(r, o) {
    return t ?? (t = e()), Reflect.deleteProperty(t, o);
  }, ownKeys(r) {
    return t ?? (t = e()), Reflect.ownKeys(t);
  }, getOwnPropertyDescriptor(r, o) {
    return t ?? (t = e()), Reflect.getOwnPropertyDescriptor(t, o);
  }, defineProperty(r, o, n) {
    return t ?? (t = e()), Reflect.defineProperty(t, o, n);
  } });
}
function D(e) {
  if (typeof e === "bigint") return e.toString() + "n";
  if (typeof e === "string") return `"${e}"`;
  return `${e}`;
}
function lb(e) {
  return Object.keys(e).filter((t) => e[t]._zod.optin === "optional" && e[t]._zod.optout === "optional");
}
var ub = { safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER], int32: [-2147483648, 2147483647], uint32: [0, 4294967295], float32: [-34028234663852886e22, 34028234663852886e22], float64: [-Number.MAX_VALUE, Number.MAX_VALUE] };
var db = { int64: [BigInt("-9223372036854775808"), BigInt("9223372036854775807")], uint64: [BigInt(0), BigInt("18446744073709551615")] };
function bZ(e, t) {
  let r = {}, o = e._zod.def;
  for (let n in t) {
    if (!(n in o.shape)) throw Error(`Unrecognized key: "${n}"`);
    if (!t[n]) continue;
    r[n] = o.shape[n];
  }
  return ct(e, { ...e._zod.def, shape: r, checks: [] });
}
function _Z(e, t) {
  let r = { ...e._zod.def.shape }, o = e._zod.def;
  for (let n in t) {
    if (!(n in o.shape)) throw Error(`Unrecognized key: "${n}"`);
    if (!t[n]) continue;
    delete r[n];
  }
  return ct(e, { ...e._zod.def, shape: r, checks: [] });
}
function vZ(e, t) {
  if (!Gi(t)) throw Error("Invalid input to extend: expected a plain object");
  let r = { ...e._zod.def, get shape() {
    let o = { ...e._zod.def.shape, ...t };
    return sb(this, "shape", o), o;
  }, checks: [] };
  return ct(e, r);
}
function SZ(e, t) {
  return ct(e, { ...e._zod.def, get shape() {
    let r = { ...e._zod.def.shape, ...t._zod.def.shape };
    return sb(this, "shape", r), r;
  }, catchall: t._zod.def.catchall, checks: [] });
}
function xZ(e, t, r) {
  let o = t._zod.def.shape, n = { ...o };
  if (r) for (let i in r) {
    if (!(i in o)) throw Error(`Unrecognized key: "${i}"`);
    if (!r[i]) continue;
    n[i] = e ? new e({ type: "optional", innerType: o[i] }) : o[i];
  }
  else for (let i in o) n[i] = e ? new e({ type: "optional", innerType: o[i] }) : o[i];
  return ct(t, { ...t._zod.def, shape: n, checks: [] });
}
function wZ(e, t, r) {
  let o = t._zod.def.shape, n = { ...o };
  if (r) for (let i in r) {
    if (!(i in n)) throw Error(`Unrecognized key: "${i}"`);
    if (!r[i]) continue;
    n[i] = new e({ type: "nonoptional", innerType: o[i] });
  }
  else for (let i in o) n[i] = new e({ type: "nonoptional", innerType: o[i] });
  return ct(t, { ...t._zod.def, shape: n, checks: [] });
}
function Io(e, t = 0) {
  for (let r = t; r < e.issues.length; r++) if (e.issues[r]?.continue !== true) return true;
  return false;
}
function kt(e, t) {
  return t.map((r) => {
    var o;
    return (o = r).path ?? (o.path = []), r.path.unshift(e), r;
  });
}
function kc(e) {
  return typeof e === "string" ? e : e?.message;
}
function Ut(e, t, r) {
  let o = { ...e, path: e.path ?? [] };
  if (!e.message) {
    let n = kc(e.inst?._zod.def?.error?.(e)) ?? kc(t?.error?.(e)) ?? kc(r.customError?.(e)) ?? kc(r.localeError?.(e)) ?? "Invalid input";
    o.message = n;
  }
  if (delete o.inst, delete o.continue, !t?.reportInput) delete o.input;
  return o;
}
function Rc(e) {
  if (e instanceof Set) return "set";
  if (e instanceof Map) return "map";
  if (e instanceof File) return "file";
  return "unknown";
}
function $c(e) {
  if (Array.isArray(e)) return "array";
  if (typeof e === "string") return "string";
  return "unknown";
}
function pb(...e) {
  let [t, r, o] = e;
  if (typeof t === "string") return { message: t, code: "custom", input: r, inst: o };
  return { ...t };
}
function kZ(e) {
  return Object.entries(e).filter(([t, r]) => Number.isNaN(Number.parseInt(t, 10))).map((t) => t[1]);
}
var ZR = class {
  constructor(...e) {
  }
};
var WR = (e, t) => {
  e.name = "$ZodError", Object.defineProperty(e, "_zod", { value: e._zod, enumerable: false }), Object.defineProperty(e, "issues", { value: t, enumerable: false }), Object.defineProperty(e, "message", { get() {
    return JSON.stringify(t, ob, 2);
  }, enumerable: true });
};
var Ac = b("$ZodError", WR);
var Ji = b("$ZodError", WR, { Parent: Error });
function Xi(e, t = (r) => r.message) {
  let r = {}, o = [];
  for (let n of e.issues) if (n.path.length > 0) r[n.path[0]] = r[n.path[0]] || [], r[n.path[0]].push(t(n));
  else o.push(t(n));
  return { formErrors: o, fieldErrors: r };
}
function Yi(e, t) {
  let r = t || function(i) {
    return i.message;
  }, o = { _errors: [] }, n = (i) => {
    for (let s of i.issues) if (s.code === "invalid_union" && s.errors.length) s.errors.map((a) => n({ issues: a }));
    else if (s.code === "invalid_key") n({ issues: s.issues });
    else if (s.code === "invalid_element") n({ issues: s.issues });
    else if (s.path.length === 0) o._errors.push(r(s));
    else {
      let a = o, c = 0;
      while (c < s.path.length) {
        let u = s.path[c];
        if (c !== s.path.length - 1) a[u] = a[u] || { _errors: [] };
        else a[u] = a[u] || { _errors: [] }, a[u]._errors.push(r(s));
        a = a[u], c++;
      }
    }
  };
  return n(e), o;
}
function Qd(e, t) {
  let r = t || function(i) {
    return i.message;
  }, o = { errors: [] }, n = (i, s = []) => {
    var a, c;
    for (let u of i.issues) if (u.code === "invalid_union" && u.errors.length) u.errors.map((d) => n({ issues: d }, u.path));
    else if (u.code === "invalid_key") n({ issues: u.issues }, u.path);
    else if (u.code === "invalid_element") n({ issues: u.issues }, u.path);
    else {
      let d = [...s, ...u.path];
      if (d.length === 0) {
        o.errors.push(r(u));
        continue;
      }
      let p = o, f = 0;
      while (f < d.length) {
        let m = d[f], g = f === d.length - 1;
        if (typeof m === "string") p.properties ?? (p.properties = {}), (a = p.properties)[m] ?? (a[m] = { errors: [] }), p = p.properties[m];
        else p.items ?? (p.items = []), (c = p.items)[m] ?? (c[m] = { errors: [] }), p = p.items[m];
        if (g) p.errors.push(r(u));
        f++;
      }
    }
  };
  return n(e), o;
}
function KR(e) {
  let t = [];
  for (let r of e) if (typeof r === "number") t.push(`[${r}]`);
  else if (typeof r === "symbol") t.push(`[${JSON.stringify(String(r))}]`);
  else if (/[^\w$]/.test(r)) t.push(`[${JSON.stringify(r)}]`);
  else {
    if (t.length) t.push(".");
    t.push(r);
  }
  return t.join("");
}
function ep(e) {
  let t = [], r = [...e.issues].sort((o, n) => o.path.length - n.path.length);
  for (let o of r) if (t.push(`\u2716 ${o.message}`), o.path?.length) t.push(`  \u2192 at ${KR(o.path)}`);
  return t.join(`
`);
}
var tp = (e) => (t, r, o, n) => {
  let i = o ? Object.assign(o, { async: false }) : { async: false }, s = t._zod.run({ value: r, issues: [] }, i);
  if (s instanceof Promise) throw new Jr();
  if (s.issues.length) {
    let a = new (n?.Err ?? e)(s.issues.map((c) => Ut(c, i, Be())));
    throw Yd(a, n?.callee), a;
  }
  return s.value;
};
var Ro = tp(Ji);
var rp = (e) => async (t, r, o, n) => {
  let i = o ? Object.assign(o, { async: true }) : { async: true }, s = t._zod.run({ value: r, issues: [] }, i);
  if (s instanceof Promise) s = await s;
  if (s.issues.length) {
    let a = new (n?.Err ?? e)(s.issues.map((c) => Ut(c, i, Be())));
    throw Yd(a, n?.callee), a;
  }
  return s.value;
};
var $o = rp(Ji);
var np = (e) => (t, r, o) => {
  let n = o ? { ...o, async: false } : { async: false }, i = t._zod.run({ value: r, issues: [] }, n);
  if (i instanceof Promise) throw new Jr();
  return i.issues.length ? { success: false, error: new (e ?? Ac)(i.issues.map((s) => Ut(s, n, Be()))) } : { success: true, data: i.value };
};
var $n = np(Ji);
var op = (e) => async (t, r, o) => {
  let n = o ? Object.assign(o, { async: true }) : { async: true }, i = t._zod.run({ value: r, issues: [] }, n);
  if (i instanceof Promise) i = await i;
  return i.issues.length ? { success: false, error: new e(i.issues.map((s) => Ut(s, n, Be()))) } : { success: true, data: i.value };
};
var An = op(Ji);
var On = {};
kr(On, { xid: () => hb, uuid7: () => RZ, uuid6: () => IZ, uuid4: () => TZ, uuid: () => Ao, uppercase: () => Fb, unicodeEmail: () => OZ, undefined: () => zb, ulid: () => gb, time: () => Ab, string: () => Cb, rfc5322Email: () => AZ, number: () => Nb, null: () => Ub, nanoid: () => bb, lowercase: () => Lb, ksuid: () => yb, ipv6: () => kb, ipv4: () => wb, integer: () => Db, html5Email: () => $Z, hostname: () => Ib, guid: () => vb, extendedDuration: () => PZ, emoji: () => xb, email: () => Sb, e164: () => Rb, duration: () => _b, domain: () => DZ, datetime: () => Ob, date: () => $b, cuid2: () => mb, cuid: () => fb, cidrv6: () => Pb, cidrv4: () => Eb, browserEmail: () => CZ, boolean: () => jb, bigint: () => Mb, base64url: () => ip, base64: () => Tb, _emoji: () => MZ });
var fb = /^[cC][^\s-]{8,}$/;
var mb = /^[0-9a-z]+$/;
var gb = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;
var hb = /^[0-9a-vA-V]{20}$/;
var yb = /^[A-Za-z0-9]{27}$/;
var bb = /^[a-zA-Z0-9_-]{21}$/;
var _b = /^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/;
var PZ = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var vb = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
var Ao = (e) => {
  if (!e) return /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000)$/;
  return new RegExp(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-${e}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`);
};
var TZ = Ao(4);
var IZ = Ao(6);
var RZ = Ao(7);
var Sb = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
var $Z = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
var AZ = /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
var OZ = /^[^\s@"]{1,64}@[^\s@]{1,255}$/u;
var CZ = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
var MZ = "^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$";
function xb() {
  return new RegExp("^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$", "u");
}
var wb = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var kb = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|::|([0-9a-fA-F]{1,4})?::([0-9a-fA-F]{1,4}:?){0,6})$/;
var Eb = /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/;
var Pb = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|::|([0-9a-fA-F]{1,4})?::([0-9a-fA-F]{1,4}:?){0,6})\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var Tb = /^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/;
var ip = /^[A-Za-z0-9_-]*$/;
var Ib = /^([a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+$/;
var DZ = /^([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
var Rb = /^\+(?:[0-9]){6,14}[0-9]$/;
var GR = "(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))";
var $b = new RegExp(`^${GR}$`);
function JR(e) {
  return typeof e.precision === "number" ? e.precision === -1 ? "(?:[01]\\d|2[0-3]):[0-5]\\d" : e.precision === 0 ? "(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d" : `(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{${e.precision}}` : "(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?";
}
function Ab(e) {
  return new RegExp(`^${JR(e)}$`);
}
function Ob(e) {
  let t = JR({ precision: e.precision }), r = ["Z"];
  if (e.local) r.push("");
  if (e.offset) r.push("([+-]\\d{2}:\\d{2})");
  let o = `${t}(?:${r.join("|")})`;
  return new RegExp(`^${GR}T(?:${o})$`);
}
var Cb = (e) => {
  let t = e ? `[\\s\\S]{${e?.minimum ?? 0},${e?.maximum ?? ""}}` : "[\\s\\S]*";
  return new RegExp(`^${t}$`);
};
var Mb = /^\d+n?$/;
var Db = /^\d+$/;
var Nb = /^-?\d+(?:\.\d+)?/i;
var jb = /true|false/i;
var Ub = /null/i;
var zb = /undefined/i;
var Lb = /^[^A-Z]*$/;
var Fb = /^[^a-z]*$/;
var Me = b("$ZodCheck", (e, t) => {
  var r;
  e._zod ?? (e._zod = {}), e._zod.def = t, (r = e._zod).onattach ?? (r.onattach = []);
});
var YR = { number: "number", bigint: "bigint", object: "date" };
var sp = b("$ZodCheckLessThan", (e, t) => {
  Me.init(e, t);
  let r = YR[typeof t.value];
  e._zod.onattach.push((o) => {
    let n = o._zod.bag, i = (t.inclusive ? n.maximum : n.exclusiveMaximum) ?? Number.POSITIVE_INFINITY;
    if (t.value < i) if (t.inclusive) n.maximum = t.value;
    else n.exclusiveMaximum = t.value;
  }), e._zod.check = (o) => {
    if (t.inclusive ? o.value <= t.value : o.value < t.value) return;
    o.issues.push({ origin: r, code: "too_big", maximum: t.value, input: o.value, inclusive: t.inclusive, inst: e, continue: !t.abort });
  };
});
var ap = b("$ZodCheckGreaterThan", (e, t) => {
  Me.init(e, t);
  let r = YR[typeof t.value];
  e._zod.onattach.push((o) => {
    let n = o._zod.bag, i = (t.inclusive ? n.minimum : n.exclusiveMinimum) ?? Number.NEGATIVE_INFINITY;
    if (t.value > i) if (t.inclusive) n.minimum = t.value;
    else n.exclusiveMinimum = t.value;
  }), e._zod.check = (o) => {
    if (t.inclusive ? o.value >= t.value : o.value > t.value) return;
    o.issues.push({ origin: r, code: "too_small", minimum: t.value, input: o.value, inclusive: t.inclusive, inst: e, continue: !t.abort });
  };
});
var Hb = b("$ZodCheckMultipleOf", (e, t) => {
  Me.init(e, t), e._zod.onattach.push((r) => {
    var o;
    (o = r._zod.bag).multipleOf ?? (o.multipleOf = t.value);
  }), e._zod.check = (r) => {
    if (typeof r.value !== typeof t.value) throw Error("Cannot mix number and bigint in multiple_of check.");
    if (typeof r.value === "bigint" ? r.value % t.value === BigInt(0) : ib(r.value, t.value) === 0) return;
    r.issues.push({ origin: typeof r.value, code: "not_multiple_of", divisor: t.value, input: r.value, inst: e, continue: !t.abort });
  };
});
var Bb = b("$ZodCheckNumberFormat", (e, t) => {
  Me.init(e, t), t.format = t.format || "float64";
  let r = t.format?.includes("int"), o = r ? "int" : "number", [n, i] = ub[t.format];
  e._zod.onattach.push((s) => {
    let a = s._zod.bag;
    if (a.format = t.format, a.minimum = n, a.maximum = i, r) a.pattern = Db;
  }), e._zod.check = (s) => {
    let a = s.value;
    if (r) {
      if (!Number.isInteger(a)) {
        s.issues.push({ expected: o, format: t.format, code: "invalid_type", input: a, inst: e });
        return;
      }
      if (!Number.isSafeInteger(a)) {
        if (a > 0) s.issues.push({ input: a, code: "too_big", maximum: Number.MAX_SAFE_INTEGER, note: "Integers must be within the safe integer range.", inst: e, origin: o, continue: !t.abort });
        else s.issues.push({ input: a, code: "too_small", minimum: Number.MIN_SAFE_INTEGER, note: "Integers must be within the safe integer range.", inst: e, origin: o, continue: !t.abort });
        return;
      }
    }
    if (a < n) s.issues.push({ origin: "number", input: a, code: "too_small", minimum: n, inclusive: true, inst: e, continue: !t.abort });
    if (a > i) s.issues.push({ origin: "number", input: a, code: "too_big", maximum: i, inst: e });
  };
});
var qb = b("$ZodCheckBigIntFormat", (e, t) => {
  Me.init(e, t);
  let [r, o] = db[t.format];
  e._zod.onattach.push((n) => {
    let i = n._zod.bag;
    i.format = t.format, i.minimum = r, i.maximum = o;
  }), e._zod.check = (n) => {
    let i = n.value;
    if (i < r) n.issues.push({ origin: "bigint", input: i, code: "too_small", minimum: r, inclusive: true, inst: e, continue: !t.abort });
    if (i > o) n.issues.push({ origin: "bigint", input: i, code: "too_big", maximum: o, inst: e });
  };
});
var Vb = b("$ZodCheckMaxSize", (e, t) => {
  Me.init(e, t), e._zod.when = (r) => {
    let o = r.value;
    return !Rn(o) && o.size !== void 0;
  }, e._zod.onattach.push((r) => {
    let o = r._zod.bag.maximum ?? Number.POSITIVE_INFINITY;
    if (t.maximum < o) r._zod.bag.maximum = t.maximum;
  }), e._zod.check = (r) => {
    let o = r.value;
    if (o.size <= t.maximum) return;
    r.issues.push({ origin: Rc(o), code: "too_big", maximum: t.maximum, input: o, inst: e, continue: !t.abort });
  };
});
var Zb = b("$ZodCheckMinSize", (e, t) => {
  Me.init(e, t), e._zod.when = (r) => {
    let o = r.value;
    return !Rn(o) && o.size !== void 0;
  }, e._zod.onattach.push((r) => {
    let o = r._zod.bag.minimum ?? Number.NEGATIVE_INFINITY;
    if (t.minimum > o) r._zod.bag.minimum = t.minimum;
  }), e._zod.check = (r) => {
    let o = r.value;
    if (o.size >= t.minimum) return;
    r.issues.push({ origin: Rc(o), code: "too_small", minimum: t.minimum, input: o, inst: e, continue: !t.abort });
  };
});
var Wb = b("$ZodCheckSizeEquals", (e, t) => {
  Me.init(e, t), e._zod.when = (r) => {
    let o = r.value;
    return !Rn(o) && o.size !== void 0;
  }, e._zod.onattach.push((r) => {
    let o = r._zod.bag;
    o.minimum = t.size, o.maximum = t.size, o.size = t.size;
  }), e._zod.check = (r) => {
    let o = r.value, n = o.size;
    if (n === t.size) return;
    let i = n > t.size;
    r.issues.push({ origin: Rc(o), ...i ? { code: "too_big", maximum: t.size } : { code: "too_small", minimum: t.size }, inclusive: true, exact: true, input: r.value, inst: e, continue: !t.abort });
  };
});
var Kb = b("$ZodCheckMaxLength", (e, t) => {
  Me.init(e, t), e._zod.when = (r) => {
    let o = r.value;
    return !Rn(o) && o.length !== void 0;
  }, e._zod.onattach.push((r) => {
    let o = r._zod.bag.maximum ?? Number.POSITIVE_INFINITY;
    if (t.maximum < o) r._zod.bag.maximum = t.maximum;
  }), e._zod.check = (r) => {
    let o = r.value;
    if (o.length <= t.maximum) return;
    let i = $c(o);
    r.issues.push({ origin: i, code: "too_big", maximum: t.maximum, inclusive: true, input: o, inst: e, continue: !t.abort });
  };
});
var Gb = b("$ZodCheckMinLength", (e, t) => {
  Me.init(e, t), e._zod.when = (r) => {
    let o = r.value;
    return !Rn(o) && o.length !== void 0;
  }, e._zod.onattach.push((r) => {
    let o = r._zod.bag.minimum ?? Number.NEGATIVE_INFINITY;
    if (t.minimum > o) r._zod.bag.minimum = t.minimum;
  }), e._zod.check = (r) => {
    let o = r.value;
    if (o.length >= t.minimum) return;
    let i = $c(o);
    r.issues.push({ origin: i, code: "too_small", minimum: t.minimum, inclusive: true, input: o, inst: e, continue: !t.abort });
  };
});
var Jb = b("$ZodCheckLengthEquals", (e, t) => {
  Me.init(e, t), e._zod.when = (r) => {
    let o = r.value;
    return !Rn(o) && o.length !== void 0;
  }, e._zod.onattach.push((r) => {
    let o = r._zod.bag;
    o.minimum = t.length, o.maximum = t.length, o.length = t.length;
  }), e._zod.check = (r) => {
    let o = r.value, n = o.length;
    if (n === t.length) return;
    let i = $c(o), s = n > t.length;
    r.issues.push({ origin: i, ...s ? { code: "too_big", maximum: t.length } : { code: "too_small", minimum: t.length }, inclusive: true, exact: true, input: r.value, inst: e, continue: !t.abort });
  };
});
var Qi = b("$ZodCheckStringFormat", (e, t) => {
  var r, o;
  if (Me.init(e, t), e._zod.onattach.push((n) => {
    let i = n._zod.bag;
    if (i.format = t.format, t.pattern) i.patterns ?? (i.patterns = /* @__PURE__ */ new Set()), i.patterns.add(t.pattern);
  }), t.pattern) (r = e._zod).check ?? (r.check = (n) => {
    if (t.pattern.lastIndex = 0, t.pattern.test(n.value)) return;
    n.issues.push({ origin: "string", code: "invalid_format", format: t.format, input: n.value, ...t.pattern ? { pattern: t.pattern.toString() } : {}, inst: e, continue: !t.abort });
  });
  else (o = e._zod).check ?? (o.check = () => {
  });
});
var Xb = b("$ZodCheckRegex", (e, t) => {
  Qi.init(e, t), e._zod.check = (r) => {
    if (t.pattern.lastIndex = 0, t.pattern.test(r.value)) return;
    r.issues.push({ origin: "string", code: "invalid_format", format: "regex", input: r.value, pattern: t.pattern.toString(), inst: e, continue: !t.abort });
  };
});
var Yb = b("$ZodCheckLowerCase", (e, t) => {
  t.pattern ?? (t.pattern = Lb), Qi.init(e, t);
});
var Qb = b("$ZodCheckUpperCase", (e, t) => {
  t.pattern ?? (t.pattern = Fb), Qi.init(e, t);
});
var e_ = b("$ZodCheckIncludes", (e, t) => {
  Me.init(e, t);
  let r = Xr(t.includes), o = new RegExp(typeof t.position === "number" ? `^.{${t.position}}${r}` : r);
  t.pattern = o, e._zod.onattach.push((n) => {
    let i = n._zod.bag;
    i.patterns ?? (i.patterns = /* @__PURE__ */ new Set()), i.patterns.add(o);
  }), e._zod.check = (n) => {
    if (n.value.includes(t.includes, t.position)) return;
    n.issues.push({ origin: "string", code: "invalid_format", format: "includes", includes: t.includes, input: n.value, inst: e, continue: !t.abort });
  };
});
var t_ = b("$ZodCheckStartsWith", (e, t) => {
  Me.init(e, t);
  let r = new RegExp(`^${Xr(t.prefix)}.*`);
  t.pattern ?? (t.pattern = r), e._zod.onattach.push((o) => {
    let n = o._zod.bag;
    n.patterns ?? (n.patterns = /* @__PURE__ */ new Set()), n.patterns.add(r);
  }), e._zod.check = (o) => {
    if (o.value.startsWith(t.prefix)) return;
    o.issues.push({ origin: "string", code: "invalid_format", format: "starts_with", prefix: t.prefix, input: o.value, inst: e, continue: !t.abort });
  };
});
var r_ = b("$ZodCheckEndsWith", (e, t) => {
  Me.init(e, t);
  let r = new RegExp(`.*${Xr(t.suffix)}$`);
  t.pattern ?? (t.pattern = r), e._zod.onattach.push((o) => {
    let n = o._zod.bag;
    n.patterns ?? (n.patterns = /* @__PURE__ */ new Set()), n.patterns.add(r);
  }), e._zod.check = (o) => {
    if (o.value.endsWith(t.suffix)) return;
    o.issues.push({ origin: "string", code: "invalid_format", format: "ends_with", suffix: t.suffix, input: o.value, inst: e, continue: !t.abort });
  };
});
function XR(e, t, r) {
  if (e.issues.length) t.issues.push(...kt(r, e.issues));
}
var n_ = b("$ZodCheckProperty", (e, t) => {
  Me.init(e, t), e._zod.check = (r) => {
    let o = t.schema._zod.run({ value: r.value[t.property], issues: [] }, {});
    if (o instanceof Promise) return o.then((n) => XR(n, r, t.property));
    XR(o, r, t.property);
    return;
  };
});
var o_ = b("$ZodCheckMimeType", (e, t) => {
  Me.init(e, t);
  let r = new Set(t.mime);
  e._zod.onattach.push((o) => {
    o._zod.bag.mime = t.mime;
  }), e._zod.check = (o) => {
    if (r.has(o.value.type)) return;
    o.issues.push({ code: "invalid_value", values: t.mime, input: o.value.type, inst: e });
  };
});
var i_ = b("$ZodCheckOverwrite", (e, t) => {
  Me.init(e, t), e._zod.check = (r) => {
    r.value = t.tx(r.value);
  };
});
var cp = class {
  constructor(e = []) {
    if (this.content = [], this.indent = 0, this) this.args = e;
  }
  indented(e) {
    this.indent += 1, e(this), this.indent -= 1;
  }
  write(e) {
    if (typeof e === "function") {
      e(this, { execution: "sync" }), e(this, { execution: "async" });
      return;
    }
    let r = e.split(`
`).filter((i) => i), o = Math.min(...r.map((i) => i.length - i.trimStart().length)), n = r.map((i) => i.slice(o)).map((i) => " ".repeat(this.indent * 2) + i);
    for (let i of n) this.content.push(i);
  }
  compile() {
    let e = Function, t = this?.args, o = [...(this?.content ?? [""]).map((n) => `  ${n}`)];
    return new e(...t, o.join(`
`));
  }
};
var s_ = { major: 4, minor: 0, patch: 0 };
var G = b("$ZodType", (e, t) => {
  var r;
  e ?? (e = {}), e._zod.def = t, e._zod.bag = e._zod.bag || {}, e._zod.version = s_;
  let o = [...e._zod.def.checks ?? []];
  if (e._zod.traits.has("$ZodCheck")) o.unshift(e);
  for (let n of o) for (let i of n._zod.onattach) i(e);
  if (o.length === 0) (r = e._zod).deferred ?? (r.deferred = []), e._zod.deferred?.push(() => {
    e._zod.run = e._zod.parse;
  });
  else {
    let n = (i, s, a) => {
      let c = Io(i), u;
      for (let d of s) {
        if (d._zod.when) {
          if (!d._zod.when(i)) continue;
        } else if (c) continue;
        let p = i.issues.length, f = d._zod.check(i);
        if (f instanceof Promise && a?.async === false) throw new Jr();
        if (u || f instanceof Promise) u = (u ?? Promise.resolve()).then(async () => {
          if (await f, i.issues.length === p) return;
          if (!c) c = Io(i, p);
        });
        else {
          if (i.issues.length === p) continue;
          if (!c) c = Io(i, p);
        }
      }
      if (u) return u.then(() => i);
      return i;
    };
    e._zod.run = (i, s) => {
      let a = e._zod.parse(i, s);
      if (a instanceof Promise) {
        if (s.async === false) throw new Jr();
        return a.then((c) => n(c, o, s));
      }
      return n(a, o, s);
    };
  }
  e["~standard"] = { validate: (n) => {
    try {
      let i = $n(e, n);
      return i.success ? { value: i.data } : { issues: i.error?.issues };
    } catch (i) {
      return An(e, n).then((s) => s.success ? { value: s.data } : { issues: s.error?.issues });
    }
  }, vendor: "zod", version: 1 };
});
var Cn = b("$ZodString", (e, t) => {
  G.init(e, t), e._zod.pattern = [...e?._zod.bag?.patterns ?? []].pop() ?? Cb(e._zod.bag), e._zod.parse = (r, o) => {
    if (t.coerce) try {
      r.value = String(r.value);
    } catch (n) {
    }
    if (typeof r.value === "string") return r;
    return r.issues.push({ expected: "string", code: "invalid_type", input: r.value, inst: e }), r;
  };
});
var xe = b("$ZodStringFormat", (e, t) => {
  Qi.init(e, t), Cn.init(e, t);
});
var dp = b("$ZodGUID", (e, t) => {
  t.pattern ?? (t.pattern = vb), xe.init(e, t);
});
var pp = b("$ZodUUID", (e, t) => {
  if (t.version) {
    let o = { v1: 1, v2: 2, v3: 3, v4: 4, v5: 5, v6: 6, v7: 7, v8: 8 }[t.version];
    if (o === void 0) throw Error(`Invalid UUID version: "${t.version}"`);
    t.pattern ?? (t.pattern = Ao(o));
  } else t.pattern ?? (t.pattern = Ao());
  xe.init(e, t);
});
var fp = b("$ZodEmail", (e, t) => {
  t.pattern ?? (t.pattern = Sb), xe.init(e, t);
});
var mp = b("$ZodURL", (e, t) => {
  xe.init(e, t), e._zod.check = (r) => {
    try {
      let o = r.value, n = new URL(o), i = n.href;
      if (t.hostname) {
        if (t.hostname.lastIndex = 0, !t.hostname.test(n.hostname)) r.issues.push({ code: "invalid_format", format: "url", note: "Invalid hostname", pattern: Ib.source, input: r.value, inst: e, continue: !t.abort });
      }
      if (t.protocol) {
        if (t.protocol.lastIndex = 0, !t.protocol.test(n.protocol.endsWith(":") ? n.protocol.slice(0, -1) : n.protocol)) r.issues.push({ code: "invalid_format", format: "url", note: "Invalid protocol", pattern: t.protocol.source, input: r.value, inst: e, continue: !t.abort });
      }
      if (!o.endsWith("/") && i.endsWith("/")) r.value = i.slice(0, -1);
      else r.value = i;
      return;
    } catch (o) {
      r.issues.push({ code: "invalid_format", format: "url", input: r.value, inst: e, continue: !t.abort });
    }
  };
});
var gp = b("$ZodEmoji", (e, t) => {
  t.pattern ?? (t.pattern = xb()), xe.init(e, t);
});
var hp = b("$ZodNanoID", (e, t) => {
  t.pattern ?? (t.pattern = bb), xe.init(e, t);
});
var yp = b("$ZodCUID", (e, t) => {
  t.pattern ?? (t.pattern = fb), xe.init(e, t);
});
var bp = b("$ZodCUID2", (e, t) => {
  t.pattern ?? (t.pattern = mb), xe.init(e, t);
});
var _p = b("$ZodULID", (e, t) => {
  t.pattern ?? (t.pattern = gb), xe.init(e, t);
});
var vp = b("$ZodXID", (e, t) => {
  t.pattern ?? (t.pattern = hb), xe.init(e, t);
});
var Sp = b("$ZodKSUID", (e, t) => {
  t.pattern ?? (t.pattern = yb), xe.init(e, t);
});
var c_ = b("$ZodISODateTime", (e, t) => {
  t.pattern ?? (t.pattern = Ob(t)), xe.init(e, t);
});
var l_ = b("$ZodISODate", (e, t) => {
  t.pattern ?? (t.pattern = $b), xe.init(e, t);
});
var u_ = b("$ZodISOTime", (e, t) => {
  t.pattern ?? (t.pattern = Ab(t)), xe.init(e, t);
});
var d_ = b("$ZodISODuration", (e, t) => {
  t.pattern ?? (t.pattern = _b), xe.init(e, t);
});
var xp = b("$ZodIPv4", (e, t) => {
  t.pattern ?? (t.pattern = wb), xe.init(e, t), e._zod.onattach.push((r) => {
    let o = r._zod.bag;
    o.format = "ipv4";
  });
});
var wp = b("$ZodIPv6", (e, t) => {
  t.pattern ?? (t.pattern = kb), xe.init(e, t), e._zod.onattach.push((r) => {
    let o = r._zod.bag;
    o.format = "ipv6";
  }), e._zod.check = (r) => {
    try {
      new URL(`http://[${r.value}]`);
    } catch {
      r.issues.push({ code: "invalid_format", format: "ipv6", input: r.value, inst: e, continue: !t.abort });
    }
  };
});
var kp = b("$ZodCIDRv4", (e, t) => {
  t.pattern ?? (t.pattern = Eb), xe.init(e, t);
});
var Ep = b("$ZodCIDRv6", (e, t) => {
  t.pattern ?? (t.pattern = Pb), xe.init(e, t), e._zod.check = (r) => {
    let [o, n] = r.value.split("/");
    try {
      if (!n) throw Error();
      let i = Number(n);
      if (`${i}` !== n) throw Error();
      if (i < 0 || i > 128) throw Error();
      new URL(`http://[${o}]`);
    } catch {
      r.issues.push({ code: "invalid_format", format: "cidrv6", input: r.value, inst: e, continue: !t.abort });
    }
  };
});
function p_(e) {
  if (e === "") return true;
  if (e.length % 4 !== 0) return false;
  try {
    return atob(e), true;
  } catch {
    return false;
  }
}
var Pp = b("$ZodBase64", (e, t) => {
  t.pattern ?? (t.pattern = Tb), xe.init(e, t), e._zod.onattach.push((r) => {
    r._zod.bag.contentEncoding = "base64";
  }), e._zod.check = (r) => {
    if (p_(r.value)) return;
    r.issues.push({ code: "invalid_format", format: "base64", input: r.value, inst: e, continue: !t.abort });
  };
});
function d$(e) {
  if (!ip.test(e)) return false;
  let t = e.replace(/[-_]/g, (o) => o === "-" ? "+" : "/"), r = t.padEnd(Math.ceil(t.length / 4) * 4, "=");
  return p_(r);
}
var Tp = b("$ZodBase64URL", (e, t) => {
  t.pattern ?? (t.pattern = ip), xe.init(e, t), e._zod.onattach.push((r) => {
    r._zod.bag.contentEncoding = "base64url";
  }), e._zod.check = (r) => {
    if (d$(r.value)) return;
    r.issues.push({ code: "invalid_format", format: "base64url", input: r.value, inst: e, continue: !t.abort });
  };
});
var Ip = b("$ZodE164", (e, t) => {
  t.pattern ?? (t.pattern = Rb), xe.init(e, t);
});
function p$(e, t = null) {
  try {
    let r = e.split(".");
    if (r.length !== 3) return false;
    let [o] = r;
    if (!o) return false;
    let n = JSON.parse(atob(o));
    if ("typ" in n && n?.typ !== "JWT") return false;
    if (!n.alg) return false;
    if (t && (!("alg" in n) || n.alg !== t)) return false;
    return true;
  } catch {
    return false;
  }
}
var Rp = b("$ZodJWT", (e, t) => {
  xe.init(e, t), e._zod.check = (r) => {
    if (p$(r.value, t.alg)) return;
    r.issues.push({ code: "invalid_format", format: "jwt", input: r.value, inst: e, continue: !t.abort });
  };
});
var $p = b("$ZodCustomStringFormat", (e, t) => {
  xe.init(e, t), e._zod.check = (r) => {
    if (t.fn(r.value)) return;
    r.issues.push({ code: "invalid_format", format: t.format, input: r.value, inst: e, continue: !t.abort });
  };
});
var Oc = b("$ZodNumber", (e, t) => {
  G.init(e, t), e._zod.pattern = e._zod.bag.pattern ?? Nb, e._zod.parse = (r, o) => {
    if (t.coerce) try {
      r.value = Number(r.value);
    } catch (s) {
    }
    let n = r.value;
    if (typeof n === "number" && !Number.isNaN(n) && Number.isFinite(n)) return r;
    let i = typeof n === "number" ? Number.isNaN(n) ? "NaN" : !Number.isFinite(n) ? "Infinity" : void 0 : void 0;
    return r.issues.push({ expected: "number", code: "invalid_type", input: n, inst: e, ...i ? { received: i } : {} }), r;
  };
});
var Ap = b("$ZodNumber", (e, t) => {
  Bb.init(e, t), Oc.init(e, t);
});
var es = b("$ZodBoolean", (e, t) => {
  G.init(e, t), e._zod.pattern = jb, e._zod.parse = (r, o) => {
    if (t.coerce) try {
      r.value = Boolean(r.value);
    } catch (i) {
    }
    let n = r.value;
    if (typeof n === "boolean") return r;
    return r.issues.push({ expected: "boolean", code: "invalid_type", input: n, inst: e }), r;
  };
});
var Cc = b("$ZodBigInt", (e, t) => {
  G.init(e, t), e._zod.pattern = Mb, e._zod.parse = (r, o) => {
    if (t.coerce) try {
      r.value = BigInt(r.value);
    } catch (n) {
    }
    if (typeof r.value === "bigint") return r;
    return r.issues.push({ expected: "bigint", code: "invalid_type", input: r.value, inst: e }), r;
  };
});
var Op = b("$ZodBigInt", (e, t) => {
  qb.init(e, t), Cc.init(e, t);
});
var Cp = b("$ZodSymbol", (e, t) => {
  G.init(e, t), e._zod.parse = (r, o) => {
    let n = r.value;
    if (typeof n === "symbol") return r;
    return r.issues.push({ expected: "symbol", code: "invalid_type", input: n, inst: e }), r;
  };
});
var Mp = b("$ZodUndefined", (e, t) => {
  G.init(e, t), e._zod.pattern = zb, e._zod.values = /* @__PURE__ */ new Set([void 0]), e._zod.optin = "optional", e._zod.optout = "optional", e._zod.parse = (r, o) => {
    let n = r.value;
    if (typeof n > "u") return r;
    return r.issues.push({ expected: "undefined", code: "invalid_type", input: n, inst: e }), r;
  };
});
var Dp = b("$ZodNull", (e, t) => {
  G.init(e, t), e._zod.pattern = Ub, e._zod.values = /* @__PURE__ */ new Set([null]), e._zod.parse = (r, o) => {
    let n = r.value;
    if (n === null) return r;
    return r.issues.push({ expected: "null", code: "invalid_type", input: n, inst: e }), r;
  };
});
var Np = b("$ZodAny", (e, t) => {
  G.init(e, t), e._zod.parse = (r) => r;
});
var Oo = b("$ZodUnknown", (e, t) => {
  G.init(e, t), e._zod.parse = (r) => r;
});
var jp = b("$ZodNever", (e, t) => {
  G.init(e, t), e._zod.parse = (r, o) => (r.issues.push({ expected: "never", code: "invalid_type", input: r.value, inst: e }), r);
});
var Up = b("$ZodVoid", (e, t) => {
  G.init(e, t), e._zod.parse = (r, o) => {
    let n = r.value;
    if (typeof n > "u") return r;
    return r.issues.push({ expected: "void", code: "invalid_type", input: n, inst: e }), r;
  };
});
var zp = b("$ZodDate", (e, t) => {
  G.init(e, t), e._zod.parse = (r, o) => {
    if (t.coerce) try {
      r.value = new Date(r.value);
    } catch (a) {
    }
    let n = r.value, i = n instanceof Date;
    if (i && !Number.isNaN(n.getTime())) return r;
    return r.issues.push({ expected: "date", code: "invalid_type", input: n, ...i ? { received: "Invalid Date" } : {}, inst: e }), r;
  };
});
function e$(e, t, r) {
  if (e.issues.length) t.issues.push(...kt(r, e.issues));
  t.value[r] = e.value;
}
var ts = b("$ZodArray", (e, t) => {
  G.init(e, t), e._zod.parse = (r, o) => {
    let n = r.value;
    if (!Array.isArray(n)) return r.issues.push({ expected: "array", code: "invalid_type", input: n, inst: e }), r;
    r.value = Array(n.length);
    let i = [];
    for (let s = 0; s < n.length; s++) {
      let a = n[s], c = t.element._zod.run({ value: a, issues: [] }, o);
      if (c instanceof Promise) i.push(c.then((u) => e$(u, r, s)));
      else e$(c, r, s);
    }
    if (i.length) return Promise.all(i).then(() => r);
    return r;
  };
});
function lp(e, t, r) {
  if (e.issues.length) t.issues.push(...kt(r, e.issues));
  t.value[r] = e.value;
}
function t$(e, t, r, o) {
  if (e.issues.length) if (o[r] === void 0) if (r in o) t.value[r] = void 0;
  else t.value[r] = e.value;
  else t.issues.push(...kt(r, e.issues));
  else if (e.value === void 0) {
    if (r in o) t.value[r] = void 0;
  } else t.value[r] = e.value;
}
var Mc = b("$ZodObject", (e, t) => {
  G.init(e, t);
  let r = Pc(() => {
    let p = Object.keys(t.shape);
    for (let m of p) if (!(t.shape[m] instanceof G)) throw Error(`Invalid element at key "${m}": expected a Zod schema`);
    let f = lb(t.shape);
    return { shape: t.shape, keys: p, keySet: new Set(p), numKeys: p.length, optionalKeys: new Set(f) };
  });
  me(e._zod, "propValues", () => {
    let p = t.shape, f = {};
    for (let m in p) {
      let g = p[m]._zod;
      if (g.values) {
        f[m] ?? (f[m] = /* @__PURE__ */ new Set());
        for (let h of g.values) f[m].add(h);
      }
    }
    return f;
  });
  let o = (p) => {
    let f = new cp(["shape", "payload", "ctx"]), m = r.value, g = (w) => {
      let x = To(w);
      return `shape[${x}]._zod.run({ value: input[${x}], issues: [] }, ctx)`;
    };
    f.write("const input = payload.value;");
    let h = /* @__PURE__ */ Object.create(null), y = 0;
    for (let w of m.keys) h[w] = `key_${y++}`;
    f.write("const newResult = {}");
    for (let w of m.keys) if (m.optionalKeys.has(w)) {
      let x = h[w];
      f.write(`const ${x} = ${g(w)};`);
      let $ = To(w);
      f.write(`
        if (${x}.issues.length) {
          if (input[${$}] === undefined) {
            if (${$} in input) {
              newResult[${$}] = undefined;
            }
          } else {
            payload.issues = payload.issues.concat(
              ${x}.issues.map((iss) => ({
                ...iss,
                path: iss.path ? [${$}, ...iss.path] : [${$}],
              }))
            );
          }
        } else if (${x}.value === undefined) {
          if (${$} in input) newResult[${$}] = undefined;
        } else {
          newResult[${$}] = ${x}.value;
        }
        `);
    } else {
      let x = h[w];
      f.write(`const ${x} = ${g(w)};`), f.write(`
          if (${x}.issues.length) payload.issues = payload.issues.concat(${x}.issues.map(iss => ({
            ...iss,
            path: iss.path ? [${To(w)}, ...iss.path] : [${To(w)}]
          })));`), f.write(`newResult[${To(w)}] = ${x}.value`);
    }
    f.write("payload.value = newResult;"), f.write("return payload;");
    let v = f.compile();
    return (w, x) => v(p, w, x);
  }, n, i = Ki, s = !wc.jitless, c = s && ab.value, u = t.catchall, d;
  e._zod.parse = (p, f) => {
    d ?? (d = r.value);
    let m = p.value;
    if (!i(m)) return p.issues.push({ expected: "object", code: "invalid_type", input: m, inst: e }), p;
    let g = [];
    if (s && c && f?.async === false && f.jitless !== true) {
      if (!n) n = o(t.shape);
      p = n(p, f);
    } else {
      p.value = {};
      let x = d.shape;
      for (let $ of d.keys) {
        let U = x[$], se = U._zod.run({ value: m[$], issues: [] }, f), Le = U._zod.optin === "optional" && U._zod.optout === "optional";
        if (se instanceof Promise) g.push(se.then((Ye) => Le ? t$(Ye, p, $, m) : lp(Ye, p, $)));
        else if (Le) t$(se, p, $, m);
        else lp(se, p, $);
      }
    }
    if (!u) return g.length ? Promise.all(g).then(() => p) : p;
    let h = [], y = d.keySet, v = u._zod, w = v.def.type;
    for (let x of Object.keys(m)) {
      if (y.has(x)) continue;
      if (w === "never") {
        h.push(x);
        continue;
      }
      let $ = v.run({ value: m[x], issues: [] }, f);
      if ($ instanceof Promise) g.push($.then((U) => lp(U, p, x)));
      else lp($, p, x);
    }
    if (h.length) p.issues.push({ code: "unrecognized_keys", keys: h, input: m, inst: e });
    if (!g.length) return p;
    return Promise.all(g).then(() => p);
  };
});
function r$(e, t, r, o) {
  for (let n of e) if (n.issues.length === 0) return t.value = n.value, t;
  return t.issues.push({ code: "invalid_union", input: t.value, inst: r, errors: e.map((n) => n.issues.map((i) => Ut(i, o, Be()))) }), t;
}
var Dc = b("$ZodUnion", (e, t) => {
  G.init(e, t), me(e._zod, "optin", () => t.options.some((r) => r._zod.optin === "optional") ? "optional" : void 0), me(e._zod, "optout", () => t.options.some((r) => r._zod.optout === "optional") ? "optional" : void 0), me(e._zod, "values", () => {
    if (t.options.every((r) => r._zod.values)) return new Set(t.options.flatMap((r) => Array.from(r._zod.values)));
    return;
  }), me(e._zod, "pattern", () => {
    if (t.options.every((r) => r._zod.pattern)) {
      let r = t.options.map((o) => o._zod.pattern);
      return new RegExp(`^(${r.map((o) => Tc(o.source)).join("|")})$`);
    }
    return;
  }), e._zod.parse = (r, o) => {
    let n = false, i = [];
    for (let s of t.options) {
      let a = s._zod.run({ value: r.value, issues: [] }, o);
      if (a instanceof Promise) i.push(a), n = true;
      else {
        if (a.issues.length === 0) return a;
        i.push(a);
      }
    }
    if (!n) return r$(i, r, e, o);
    return Promise.all(i).then((s) => r$(s, r, e, o));
  };
});
var Lp = b("$ZodDiscriminatedUnion", (e, t) => {
  Dc.init(e, t);
  let r = e._zod.parse;
  me(e._zod, "propValues", () => {
    let n = {};
    for (let i of t.options) {
      let s = i._zod.propValues;
      if (!s || Object.keys(s).length === 0) throw Error(`Invalid discriminated union option at index "${t.options.indexOf(i)}"`);
      for (let [a, c] of Object.entries(s)) {
        if (!n[a]) n[a] = /* @__PURE__ */ new Set();
        for (let u of c) n[a].add(u);
      }
    }
    return n;
  });
  let o = Pc(() => {
    let n = t.options, i = /* @__PURE__ */ new Map();
    for (let s of n) {
      let a = s._zod.propValues[t.discriminator];
      if (!a || a.size === 0) throw Error(`Invalid discriminated union option at index "${t.options.indexOf(s)}"`);
      for (let c of a) {
        if (i.has(c)) throw Error(`Duplicate discriminator value "${String(c)}"`);
        i.set(c, s);
      }
    }
    return i;
  });
  e._zod.parse = (n, i) => {
    let s = n.value;
    if (!Ki(s)) return n.issues.push({ code: "invalid_type", expected: "object", input: s, inst: e }), n;
    let a = o.value.get(s?.[t.discriminator]);
    if (a) return a._zod.run(n, i);
    if (t.unionFallback) return r(n, i);
    return n.issues.push({ code: "invalid_union", errors: [], note: "No matching discriminator", input: s, path: [t.discriminator], inst: e }), n;
  };
});
var Fp = b("$ZodIntersection", (e, t) => {
  G.init(e, t), e._zod.parse = (r, o) => {
    let n = r.value, i = t.left._zod.run({ value: n, issues: [] }, o), s = t.right._zod.run({ value: n, issues: [] }, o);
    if (i instanceof Promise || s instanceof Promise) return Promise.all([i, s]).then(([c, u]) => n$(r, c, u));
    return n$(r, i, s);
  };
});
function a_(e, t) {
  if (e === t) return { valid: true, data: e };
  if (e instanceof Date && t instanceof Date && +e === +t) return { valid: true, data: e };
  if (Gi(e) && Gi(t)) {
    let r = Object.keys(t), o = Object.keys(e).filter((i) => r.indexOf(i) !== -1), n = { ...e, ...t };
    for (let i of o) {
      let s = a_(e[i], t[i]);
      if (!s.valid) return { valid: false, mergeErrorPath: [i, ...s.mergeErrorPath] };
      n[i] = s.data;
    }
    return { valid: true, data: n };
  }
  if (Array.isArray(e) && Array.isArray(t)) {
    if (e.length !== t.length) return { valid: false, mergeErrorPath: [] };
    let r = [];
    for (let o = 0; o < e.length; o++) {
      let n = e[o], i = t[o], s = a_(n, i);
      if (!s.valid) return { valid: false, mergeErrorPath: [o, ...s.mergeErrorPath] };
      r.push(s.data);
    }
    return { valid: true, data: r };
  }
  return { valid: false, mergeErrorPath: [] };
}
function n$(e, t, r) {
  if (t.issues.length) e.issues.push(...t.issues);
  if (r.issues.length) e.issues.push(...r.issues);
  if (Io(e)) return e;
  let o = a_(t.value, r.value);
  if (!o.valid) throw Error(`Unmergable intersection. Error path: ${JSON.stringify(o.mergeErrorPath)}`);
  return e.value = o.data, e;
}
var Mn = b("$ZodTuple", (e, t) => {
  G.init(e, t);
  let r = t.items, o = r.length - [...r].reverse().findIndex((n) => n._zod.optin !== "optional");
  e._zod.parse = (n, i) => {
    let s = n.value;
    if (!Array.isArray(s)) return n.issues.push({ input: s, inst: e, expected: "tuple", code: "invalid_type" }), n;
    n.value = [];
    let a = [];
    if (!t.rest) {
      let u = s.length > r.length, d = s.length < o - 1;
      if (u || d) return n.issues.push({ input: s, inst: e, origin: "array", ...u ? { code: "too_big", maximum: r.length } : { code: "too_small", minimum: r.length } }), n;
    }
    let c = -1;
    for (let u of r) {
      if (c++, c >= s.length) {
        if (c >= o) continue;
      }
      let d = u._zod.run({ value: s[c], issues: [] }, i);
      if (d instanceof Promise) a.push(d.then((p) => up(p, n, c)));
      else up(d, n, c);
    }
    if (t.rest) {
      let u = s.slice(r.length);
      for (let d of u) {
        c++;
        let p = t.rest._zod.run({ value: d, issues: [] }, i);
        if (p instanceof Promise) a.push(p.then((f) => up(f, n, c)));
        else up(p, n, c);
      }
    }
    if (a.length) return Promise.all(a).then(() => n);
    return n;
  };
});
function up(e, t, r) {
  if (e.issues.length) t.issues.push(...kt(r, e.issues));
  t.value[r] = e.value;
}
var Hp = b("$ZodRecord", (e, t) => {
  G.init(e, t), e._zod.parse = (r, o) => {
    let n = r.value;
    if (!Gi(n)) return r.issues.push({ expected: "record", code: "invalid_type", input: n, inst: e }), r;
    let i = [];
    if (t.keyType._zod.values) {
      let s = t.keyType._zod.values;
      r.value = {};
      for (let c of s) if (typeof c === "string" || typeof c === "number" || typeof c === "symbol") {
        let u = t.valueType._zod.run({ value: n[c], issues: [] }, o);
        if (u instanceof Promise) i.push(u.then((d) => {
          if (d.issues.length) r.issues.push(...kt(c, d.issues));
          r.value[c] = d.value;
        }));
        else {
          if (u.issues.length) r.issues.push(...kt(c, u.issues));
          r.value[c] = u.value;
        }
      }
      let a;
      for (let c in n) if (!s.has(c)) a = a ?? [], a.push(c);
      if (a && a.length > 0) r.issues.push({ code: "unrecognized_keys", input: n, inst: e, keys: a });
    } else {
      r.value = {};
      for (let s of Reflect.ownKeys(n)) {
        if (s === "__proto__") continue;
        let a = t.keyType._zod.run({ value: s, issues: [] }, o);
        if (a instanceof Promise) throw Error("Async schemas not supported in object keys currently");
        if (a.issues.length) {
          r.issues.push({ origin: "record", code: "invalid_key", issues: a.issues.map((u) => Ut(u, o, Be())), input: s, path: [s], inst: e }), r.value[a.value] = a.value;
          continue;
        }
        let c = t.valueType._zod.run({ value: n[s], issues: [] }, o);
        if (c instanceof Promise) i.push(c.then((u) => {
          if (u.issues.length) r.issues.push(...kt(s, u.issues));
          r.value[a.value] = u.value;
        }));
        else {
          if (c.issues.length) r.issues.push(...kt(s, c.issues));
          r.value[a.value] = c.value;
        }
      }
    }
    if (i.length) return Promise.all(i).then(() => r);
    return r;
  };
});
var Bp = b("$ZodMap", (e, t) => {
  G.init(e, t), e._zod.parse = (r, o) => {
    let n = r.value;
    if (!(n instanceof Map)) return r.issues.push({ expected: "map", code: "invalid_type", input: n, inst: e }), r;
    let i = [];
    r.value = /* @__PURE__ */ new Map();
    for (let [s, a] of n) {
      let c = t.keyType._zod.run({ value: s, issues: [] }, o), u = t.valueType._zod.run({ value: a, issues: [] }, o);
      if (c instanceof Promise || u instanceof Promise) i.push(Promise.all([c, u]).then(([d, p]) => {
        o$(d, p, r, s, n, e, o);
      }));
      else o$(c, u, r, s, n, e, o);
    }
    if (i.length) return Promise.all(i).then(() => r);
    return r;
  };
});
function o$(e, t, r, o, n, i, s) {
  if (e.issues.length) if (Ic.has(typeof o)) r.issues.push(...kt(o, e.issues));
  else r.issues.push({ origin: "map", code: "invalid_key", input: n, inst: i, issues: e.issues.map((a) => Ut(a, s, Be())) });
  if (t.issues.length) if (Ic.has(typeof o)) r.issues.push(...kt(o, t.issues));
  else r.issues.push({ origin: "map", code: "invalid_element", input: n, inst: i, key: o, issues: t.issues.map((a) => Ut(a, s, Be())) });
  r.value.set(e.value, t.value);
}
var qp = b("$ZodSet", (e, t) => {
  G.init(e, t), e._zod.parse = (r, o) => {
    let n = r.value;
    if (!(n instanceof Set)) return r.issues.push({ input: n, inst: e, expected: "set", code: "invalid_type" }), r;
    let i = [];
    r.value = /* @__PURE__ */ new Set();
    for (let s of n) {
      let a = t.valueType._zod.run({ value: s, issues: [] }, o);
      if (a instanceof Promise) i.push(a.then((c) => i$(c, r)));
      else i$(a, r);
    }
    if (i.length) return Promise.all(i).then(() => r);
    return r;
  };
});
function i$(e, t) {
  if (e.issues.length) t.issues.push(...e.issues);
  t.value.add(e.value);
}
var Vp = b("$ZodEnum", (e, t) => {
  G.init(e, t);
  let r = Ec(t.entries);
  e._zod.values = new Set(r), e._zod.pattern = new RegExp(`^(${r.filter((o) => Ic.has(typeof o)).map((o) => typeof o === "string" ? Xr(o) : o.toString()).join("|")})$`), e._zod.parse = (o, n) => {
    let i = o.value;
    if (e._zod.values.has(i)) return o;
    return o.issues.push({ code: "invalid_value", values: r, input: i, inst: e }), o;
  };
});
var Zp = b("$ZodLiteral", (e, t) => {
  G.init(e, t), e._zod.values = new Set(t.values), e._zod.pattern = new RegExp(`^(${t.values.map((r) => typeof r === "string" ? Xr(r) : r ? r.toString() : String(r)).join("|")})$`), e._zod.parse = (r, o) => {
    let n = r.value;
    if (e._zod.values.has(n)) return r;
    return r.issues.push({ code: "invalid_value", values: t.values, input: n, inst: e }), r;
  };
});
var Wp = b("$ZodFile", (e, t) => {
  G.init(e, t), e._zod.parse = (r, o) => {
    let n = r.value;
    if (n instanceof File) return r;
    return r.issues.push({ expected: "file", code: "invalid_type", input: n, inst: e }), r;
  };
});
var rs = b("$ZodTransform", (e, t) => {
  G.init(e, t), e._zod.parse = (r, o) => {
    let n = t.transform(r.value, r);
    if (o.async) return (n instanceof Promise ? n : Promise.resolve(n)).then((s) => (r.value = s, r));
    if (n instanceof Promise) throw new Jr();
    return r.value = n, r;
  };
});
var Kp = b("$ZodOptional", (e, t) => {
  G.init(e, t), e._zod.optin = "optional", e._zod.optout = "optional", me(e._zod, "values", () => t.innerType._zod.values ? /* @__PURE__ */ new Set([...t.innerType._zod.values, void 0]) : void 0), me(e._zod, "pattern", () => {
    let r = t.innerType._zod.pattern;
    return r ? new RegExp(`^(${Tc(r.source)})?$`) : void 0;
  }), e._zod.parse = (r, o) => {
    if (t.innerType._zod.optin === "optional") return t.innerType._zod.run(r, o);
    if (r.value === void 0) return r;
    return t.innerType._zod.run(r, o);
  };
});
var Gp = b("$ZodNullable", (e, t) => {
  G.init(e, t), me(e._zod, "optin", () => t.innerType._zod.optin), me(e._zod, "optout", () => t.innerType._zod.optout), me(e._zod, "pattern", () => {
    let r = t.innerType._zod.pattern;
    return r ? new RegExp(`^(${Tc(r.source)}|null)$`) : void 0;
  }), me(e._zod, "values", () => t.innerType._zod.values ? /* @__PURE__ */ new Set([...t.innerType._zod.values, null]) : void 0), e._zod.parse = (r, o) => {
    if (r.value === null) return r;
    return t.innerType._zod.run(r, o);
  };
});
var Jp = b("$ZodDefault", (e, t) => {
  G.init(e, t), e._zod.optin = "optional", me(e._zod, "values", () => t.innerType._zod.values), e._zod.parse = (r, o) => {
    if (r.value === void 0) return r.value = t.defaultValue, r;
    let n = t.innerType._zod.run(r, o);
    if (n instanceof Promise) return n.then((i) => s$(i, t));
    return s$(n, t);
  };
});
function s$(e, t) {
  if (e.value === void 0) e.value = t.defaultValue;
  return e;
}
var Xp = b("$ZodPrefault", (e, t) => {
  G.init(e, t), e._zod.optin = "optional", me(e._zod, "values", () => t.innerType._zod.values), e._zod.parse = (r, o) => {
    if (r.value === void 0) r.value = t.defaultValue;
    return t.innerType._zod.run(r, o);
  };
});
var Yp = b("$ZodNonOptional", (e, t) => {
  G.init(e, t), me(e._zod, "values", () => {
    let r = t.innerType._zod.values;
    return r ? new Set([...r].filter((o) => o !== void 0)) : void 0;
  }), e._zod.parse = (r, o) => {
    let n = t.innerType._zod.run(r, o);
    if (n instanceof Promise) return n.then((i) => a$(i, e));
    return a$(n, e);
  };
});
function a$(e, t) {
  if (!e.issues.length && e.value === void 0) e.issues.push({ code: "invalid_type", expected: "nonoptional", input: e.value, inst: t });
  return e;
}
var Qp = b("$ZodSuccess", (e, t) => {
  G.init(e, t), e._zod.parse = (r, o) => {
    let n = t.innerType._zod.run(r, o);
    if (n instanceof Promise) return n.then((i) => (r.value = i.issues.length === 0, r));
    return r.value = n.issues.length === 0, r;
  };
});
var ef = b("$ZodCatch", (e, t) => {
  G.init(e, t), e._zod.optin = "optional", me(e._zod, "optout", () => t.innerType._zod.optout), me(e._zod, "values", () => t.innerType._zod.values), e._zod.parse = (r, o) => {
    let n = t.innerType._zod.run(r, o);
    if (n instanceof Promise) return n.then((i) => {
      if (r.value = i.value, i.issues.length) r.value = t.catchValue({ ...r, error: { issues: i.issues.map((s) => Ut(s, o, Be())) }, input: r.value }), r.issues = [];
      return r;
    });
    if (r.value = n.value, n.issues.length) r.value = t.catchValue({ ...r, error: { issues: n.issues.map((i) => Ut(i, o, Be())) }, input: r.value }), r.issues = [];
    return r;
  };
});
var tf = b("$ZodNaN", (e, t) => {
  G.init(e, t), e._zod.parse = (r, o) => {
    if (typeof r.value !== "number" || !Number.isNaN(r.value)) return r.issues.push({ input: r.value, inst: e, expected: "nan", code: "invalid_type" }), r;
    return r;
  };
});
var ns = b("$ZodPipe", (e, t) => {
  G.init(e, t), me(e._zod, "values", () => t.in._zod.values), me(e._zod, "optin", () => t.in._zod.optin), me(e._zod, "optout", () => t.out._zod.optout), e._zod.parse = (r, o) => {
    let n = t.in._zod.run(r, o);
    if (n instanceof Promise) return n.then((i) => c$(i, t, o));
    return c$(n, t, o);
  };
});
function c$(e, t, r) {
  if (Io(e)) return e;
  return t.out._zod.run({ value: e.value, issues: e.issues }, r);
}
var rf = b("$ZodReadonly", (e, t) => {
  G.init(e, t), me(e._zod, "propValues", () => t.innerType._zod.propValues), me(e._zod, "values", () => t.innerType._zod.values), me(e._zod, "optin", () => t.innerType._zod.optin), me(e._zod, "optout", () => t.innerType._zod.optout), e._zod.parse = (r, o) => {
    let n = t.innerType._zod.run(r, o);
    if (n instanceof Promise) return n.then(l$);
    return l$(n);
  };
});
function l$(e) {
  return e.value = Object.freeze(e.value), e;
}
var nf = b("$ZodTemplateLiteral", (e, t) => {
  G.init(e, t);
  let r = [];
  for (let o of t.parts) if (o instanceof G) {
    if (!o._zod.pattern) throw Error(`Invalid template literal part, no pattern found: ${[...o._zod.traits].shift()}`);
    let n = o._zod.pattern instanceof RegExp ? o._zod.pattern.source : o._zod.pattern;
    if (!n) throw Error(`Invalid template literal part: ${o._zod.traits}`);
    let i = n.startsWith("^") ? 1 : 0, s = n.endsWith("$") ? n.length - 1 : n.length;
    r.push(n.slice(i, s));
  } else if (o === null || cb.has(typeof o)) r.push(Xr(`${o}`));
  else throw Error(`Invalid template literal part: ${o}`);
  e._zod.pattern = new RegExp(`^${r.join("")}$`), e._zod.parse = (o, n) => {
    if (typeof o.value !== "string") return o.issues.push({ input: o.value, inst: e, expected: "template_literal", code: "invalid_type" }), o;
    if (e._zod.pattern.lastIndex = 0, !e._zod.pattern.test(o.value)) return o.issues.push({ input: o.value, inst: e, code: "invalid_format", format: "template_literal", pattern: e._zod.pattern.source }), o;
    return o;
  };
});
var of = b("$ZodPromise", (e, t) => {
  G.init(e, t), e._zod.parse = (r, o) => Promise.resolve(r.value).then((n) => t.innerType._zod.run({ value: n, issues: [] }, o));
});
var sf = b("$ZodLazy", (e, t) => {
  G.init(e, t), me(e._zod, "innerType", () => t.getter()), me(e._zod, "pattern", () => e._zod.innerType._zod.pattern), me(e._zod, "propValues", () => e._zod.innerType._zod.propValues), me(e._zod, "optin", () => e._zod.innerType._zod.optin), me(e._zod, "optout", () => e._zod.innerType._zod.optout), e._zod.parse = (r, o) => e._zod.innerType._zod.run(r, o);
});
var af = b("$ZodCustom", (e, t) => {
  Me.init(e, t), G.init(e, t), e._zod.parse = (r, o) => r, e._zod.check = (r) => {
    let o = r.value, n = t.fn(o);
    if (n instanceof Promise) return n.then((i) => u$(i, r, o, e));
    u$(n, r, o, e);
    return;
  };
});
function u$(e, t, r, o) {
  if (!e) {
    let n = { code: "custom", input: r, inst: o, path: [...o._zod.def.path ?? []], continue: !o._zod.def.abort };
    if (o._zod.def.params) n.params = o._zod.def.params;
    t.issues.push(pb(n));
  }
}
var os = {};
kr(os, { zhTW: () => J_, zhCN: () => G_, vi: () => K_, ur: () => W_, ua: () => Z_, tr: () => V_, th: () => q_, ta: () => B_, sv: () => H_, sl: () => F_, ru: () => L_, pt: () => z_, ps: () => j_, pl: () => U_, ota: () => N_, no: () => D_, nl: () => M_, ms: () => C_, mk: () => O_, ko: () => A_, kh: () => $_, ja: () => R_, it: () => I_, id: () => T_, hu: () => P_, he: () => E_, frCA: () => k_, fr: () => w_, fi: () => x_, fa: () => S_, es: () => v_, eo: () => __, en: () => Nc, de: () => b_, cs: () => y_, ca: () => h_, be: () => g_, az: () => m_, ar: () => f_ });
var NZ = () => {
  let e = { string: { unit: "\u062D\u0631\u0641", verb: "\u0623\u0646 \u064A\u062D\u0648\u064A" }, file: { unit: "\u0628\u0627\u064A\u062A", verb: "\u0623\u0646 \u064A\u062D\u0648\u064A" }, array: { unit: "\u0639\u0646\u0635\u0631", verb: "\u0623\u0646 \u064A\u062D\u0648\u064A" }, set: { unit: "\u0639\u0646\u0635\u0631", verb: "\u0623\u0646 \u064A\u062D\u0648\u064A" } };
  function t(n) {
    return e[n] ?? null;
  }
  let r = (n) => {
    let i = typeof n;
    switch (i) {
      case "number":
        return Number.isNaN(n) ? "NaN" : "number";
      case "object": {
        if (Array.isArray(n)) return "array";
        if (n === null) return "null";
        if (Object.getPrototypeOf(n) !== Object.prototype && n.constructor) return n.constructor.name;
      }
    }
    return i;
  }, o = { regex: "\u0645\u062F\u062E\u0644", email: "\u0628\u0631\u064A\u062F \u0625\u0644\u0643\u062A\u0631\u0648\u0646\u064A", url: "\u0631\u0627\u0628\u0637", emoji: "\u0625\u064A\u0645\u0648\u062C\u064A", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "\u062A\u0627\u0631\u064A\u062E \u0648\u0648\u0642\u062A \u0628\u0645\u0639\u064A\u0627\u0631 ISO", date: "\u062A\u0627\u0631\u064A\u062E \u0628\u0645\u0639\u064A\u0627\u0631 ISO", time: "\u0648\u0642\u062A \u0628\u0645\u0639\u064A\u0627\u0631 ISO", duration: "\u0645\u062F\u0629 \u0628\u0645\u0639\u064A\u0627\u0631 ISO", ipv4: "\u0639\u0646\u0648\u0627\u0646 IPv4", ipv6: "\u0639\u0646\u0648\u0627\u0646 IPv6", cidrv4: "\u0645\u062F\u0649 \u0639\u0646\u0627\u0648\u064A\u0646 \u0628\u0635\u064A\u063A\u0629 IPv4", cidrv6: "\u0645\u062F\u0649 \u0639\u0646\u0627\u0648\u064A\u0646 \u0628\u0635\u064A\u063A\u0629 IPv6", base64: "\u0646\u064E\u0635 \u0628\u062A\u0631\u0645\u064A\u0632 base64-encoded", base64url: "\u0646\u064E\u0635 \u0628\u062A\u0631\u0645\u064A\u0632 base64url-encoded", json_string: "\u0646\u064E\u0635 \u0639\u0644\u0649 \u0647\u064A\u0626\u0629 JSON", e164: "\u0631\u0642\u0645 \u0647\u0627\u062A\u0641 \u0628\u0645\u0639\u064A\u0627\u0631 E.164", jwt: "JWT", template_literal: "\u0645\u062F\u062E\u0644" };
  return (n) => {
    switch (n.code) {
      case "invalid_type":
        return `\u0645\u062F\u062E\u0644\u0627\u062A \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644\u0629: \u064A\u0641\u062A\u0631\u0636 \u0625\u062F\u062E\u0627\u0644 ${n.expected}\u060C \u0648\u0644\u0643\u0646 \u062A\u0645 \u0625\u062F\u062E\u0627\u0644 ${r(n.input)}`;
      case "invalid_value":
        if (n.values.length === 1) return `\u0645\u062F\u062E\u0644\u0627\u062A \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644\u0629: \u064A\u0641\u062A\u0631\u0636 \u0625\u062F\u062E\u0627\u0644 ${D(n.values[0])}`;
        return `\u0627\u062E\u062A\u064A\u0627\u0631 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644: \u064A\u062A\u0648\u0642\u0639 \u0627\u0646\u062A\u0642\u0627\u0621 \u0623\u062D\u062F \u0647\u0630\u0647 \u0627\u0644\u062E\u064A\u0627\u0631\u0627\u062A: ${P(n.values, "|")}`;
      case "too_big": {
        let i = n.inclusive ? "<=" : "<", s = t(n.origin);
        if (s) return ` \u0623\u0643\u0628\u0631 \u0645\u0646 \u0627\u0644\u0644\u0627\u0632\u0645: \u064A\u0641\u062A\u0631\u0636 \u0623\u0646 \u062A\u0643\u0648\u0646 ${n.origin ?? "\u0627\u0644\u0642\u064A\u0645\u0629"} ${i} ${n.maximum.toString()} ${s.unit ?? "\u0639\u0646\u0635\u0631"}`;
        return `\u0623\u0643\u0628\u0631 \u0645\u0646 \u0627\u0644\u0644\u0627\u0632\u0645: \u064A\u0641\u062A\u0631\u0636 \u0623\u0646 \u062A\u0643\u0648\u0646 ${n.origin ?? "\u0627\u0644\u0642\u064A\u0645\u0629"} ${i} ${n.maximum.toString()}`;
      }
      case "too_small": {
        let i = n.inclusive ? ">=" : ">", s = t(n.origin);
        if (s) return `\u0623\u0635\u063A\u0631 \u0645\u0646 \u0627\u0644\u0644\u0627\u0632\u0645: \u064A\u0641\u062A\u0631\u0636 \u0644\u0640 ${n.origin} \u0623\u0646 \u064A\u0643\u0648\u0646 ${i} ${n.minimum.toString()} ${s.unit}`;
        return `\u0623\u0635\u063A\u0631 \u0645\u0646 \u0627\u0644\u0644\u0627\u0632\u0645: \u064A\u0641\u062A\u0631\u0636 \u0644\u0640 ${n.origin} \u0623\u0646 \u064A\u0643\u0648\u0646 ${i} ${n.minimum.toString()}`;
      }
      case "invalid_format": {
        let i = n;
        if (i.format === "starts_with") return `\u0646\u064E\u0635 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644: \u064A\u062C\u0628 \u0623\u0646 \u064A\u0628\u062F\u0623 \u0628\u0640 "${n.prefix}"`;
        if (i.format === "ends_with") return `\u0646\u064E\u0635 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644: \u064A\u062C\u0628 \u0623\u0646 \u064A\u0646\u062A\u0647\u064A \u0628\u0640 "${i.suffix}"`;
        if (i.format === "includes") return `\u0646\u064E\u0635 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644: \u064A\u062C\u0628 \u0623\u0646 \u064A\u062A\u0636\u0645\u0651\u064E\u0646 "${i.includes}"`;
        if (i.format === "regex") return `\u0646\u064E\u0635 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644: \u064A\u062C\u0628 \u0623\u0646 \u064A\u0637\u0627\u0628\u0642 \u0627\u0644\u0646\u0645\u0637 ${i.pattern}`;
        return `${o[i.format] ?? n.format} \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644`;
      }
      case "not_multiple_of":
        return `\u0631\u0642\u0645 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644: \u064A\u062C\u0628 \u0623\u0646 \u064A\u0643\u0648\u0646 \u0645\u0646 \u0645\u0636\u0627\u0639\u0641\u0627\u062A ${n.divisor}`;
      case "unrecognized_keys":
        return `\u0645\u0639\u0631\u0641${n.keys.length > 1 ? "\u0627\u062A" : ""} \u063A\u0631\u064A\u0628${n.keys.length > 1 ? "\u0629" : ""}: ${P(n.keys, "\u060C ")}`;
      case "invalid_key":
        return `\u0645\u0639\u0631\u0641 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644 \u0641\u064A ${n.origin}`;
      case "invalid_union":
        return "\u0645\u062F\u062E\u0644 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644";
      case "invalid_element":
        return `\u0645\u062F\u062E\u0644 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644 \u0641\u064A ${n.origin}`;
      default:
        return "\u0645\u062F\u062E\u0644 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644";
    }
  };
};
function f_() {
  return { localeError: NZ() };
}
var jZ = () => {
  let e = { string: { unit: "simvol", verb: "olmal\u0131d\u0131r" }, file: { unit: "bayt", verb: "olmal\u0131d\u0131r" }, array: { unit: "element", verb: "olmal\u0131d\u0131r" }, set: { unit: "element", verb: "olmal\u0131d\u0131r" } };
  function t(n) {
    return e[n] ?? null;
  }
  let r = (n) => {
    let i = typeof n;
    switch (i) {
      case "number":
        return Number.isNaN(n) ? "NaN" : "number";
      case "object": {
        if (Array.isArray(n)) return "array";
        if (n === null) return "null";
        if (Object.getPrototypeOf(n) !== Object.prototype && n.constructor) return n.constructor.name;
      }
    }
    return i;
  }, o = { regex: "input", email: "email address", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO datetime", date: "ISO date", time: "ISO time", duration: "ISO duration", ipv4: "IPv4 address", ipv6: "IPv6 address", cidrv4: "IPv4 range", cidrv6: "IPv6 range", base64: "base64-encoded string", base64url: "base64url-encoded string", json_string: "JSON string", e164: "E.164 number", jwt: "JWT", template_literal: "input" };
  return (n) => {
    switch (n.code) {
      case "invalid_type":
        return `Yanl\u0131\u015F d\u0259y\u0259r: g\xF6zl\u0259nil\u0259n ${n.expected}, daxil olan ${r(n.input)}`;
      case "invalid_value":
        if (n.values.length === 1) return `Yanl\u0131\u015F d\u0259y\u0259r: g\xF6zl\u0259nil\u0259n ${D(n.values[0])}`;
        return `Yanl\u0131\u015F se\xE7im: a\u015Fa\u011F\u0131dak\u0131lardan biri olmal\u0131d\u0131r: ${P(n.values, "|")}`;
      case "too_big": {
        let i = n.inclusive ? "<=" : "<", s = t(n.origin);
        if (s) return `\xC7ox b\xF6y\xFCk: g\xF6zl\u0259nil\u0259n ${n.origin ?? "d\u0259y\u0259r"} ${i}${n.maximum.toString()} ${s.unit ?? "element"}`;
        return `\xC7ox b\xF6y\xFCk: g\xF6zl\u0259nil\u0259n ${n.origin ?? "d\u0259y\u0259r"} ${i}${n.maximum.toString()}`;
      }
      case "too_small": {
        let i = n.inclusive ? ">=" : ">", s = t(n.origin);
        if (s) return `\xC7ox ki\xE7ik: g\xF6zl\u0259nil\u0259n ${n.origin} ${i}${n.minimum.toString()} ${s.unit}`;
        return `\xC7ox ki\xE7ik: g\xF6zl\u0259nil\u0259n ${n.origin} ${i}${n.minimum.toString()}`;
      }
      case "invalid_format": {
        let i = n;
        if (i.format === "starts_with") return `Yanl\u0131\u015F m\u0259tn: "${i.prefix}" il\u0259 ba\u015Flamal\u0131d\u0131r`;
        if (i.format === "ends_with") return `Yanl\u0131\u015F m\u0259tn: "${i.suffix}" il\u0259 bitm\u0259lidir`;
        if (i.format === "includes") return `Yanl\u0131\u015F m\u0259tn: "${i.includes}" daxil olmal\u0131d\u0131r`;
        if (i.format === "regex") return `Yanl\u0131\u015F m\u0259tn: ${i.pattern} \u015Fablonuna uy\u011Fun olmal\u0131d\u0131r`;
        return `Yanl\u0131\u015F ${o[i.format] ?? n.format}`;
      }
      case "not_multiple_of":
        return `Yanl\u0131\u015F \u0259d\u0259d: ${n.divisor} il\u0259 b\xF6l\xFCn\u0259 bil\u0259n olmal\u0131d\u0131r`;
      case "unrecognized_keys":
        return `Tan\u0131nmayan a\xE7ar${n.keys.length > 1 ? "lar" : ""}: ${P(n.keys, ", ")}`;
      case "invalid_key":
        return `${n.origin} daxilind\u0259 yanl\u0131\u015F a\xE7ar`;
      case "invalid_union":
        return "Yanl\u0131\u015F d\u0259y\u0259r";
      case "invalid_element":
        return `${n.origin} daxilind\u0259 yanl\u0131\u015F d\u0259y\u0259r`;
      default:
        return "Yanl\u0131\u015F d\u0259y\u0259r";
    }
  };
};
function m_() {
  return { localeError: jZ() };
}
function m$(e, t, r, o) {
  let n = Math.abs(e), i = n % 10, s = n % 100;
  if (s >= 11 && s <= 19) return o;
  if (i === 1) return t;
  if (i >= 2 && i <= 4) return r;
  return o;
}
var UZ = () => {
  let e = { string: { unit: { one: "\u0441\u0456\u043C\u0432\u0430\u043B", few: "\u0441\u0456\u043C\u0432\u0430\u043B\u044B", many: "\u0441\u0456\u043C\u0432\u0430\u043B\u0430\u045E" }, verb: "\u043C\u0435\u0446\u044C" }, array: { unit: { one: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442", few: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u044B", many: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u0430\u045E" }, verb: "\u043C\u0435\u0446\u044C" }, set: { unit: { one: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442", few: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u044B", many: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u0430\u045E" }, verb: "\u043C\u0435\u0446\u044C" }, file: { unit: { one: "\u0431\u0430\u0439\u0442", few: "\u0431\u0430\u0439\u0442\u044B", many: "\u0431\u0430\u0439\u0442\u0430\u045E" }, verb: "\u043C\u0435\u0446\u044C" } };
  function t(n) {
    return e[n] ?? null;
  }
  let r = (n) => {
    let i = typeof n;
    switch (i) {
      case "number":
        return Number.isNaN(n) ? "NaN" : "\u043B\u0456\u043A";
      case "object": {
        if (Array.isArray(n)) return "\u043C\u0430\u0441\u0456\u045E";
        if (n === null) return "null";
        if (Object.getPrototypeOf(n) !== Object.prototype && n.constructor) return n.constructor.name;
      }
    }
    return i;
  }, o = { regex: "\u0443\u0432\u043E\u0434", email: "email \u0430\u0434\u0440\u0430\u0441", url: "URL", emoji: "\u044D\u043C\u043E\u0434\u0437\u0456", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO \u0434\u0430\u0442\u0430 \u0456 \u0447\u0430\u0441", date: "ISO \u0434\u0430\u0442\u0430", time: "ISO \u0447\u0430\u0441", duration: "ISO \u043F\u0440\u0430\u0446\u044F\u0433\u043B\u0430\u0441\u0446\u044C", ipv4: "IPv4 \u0430\u0434\u0440\u0430\u0441", ipv6: "IPv6 \u0430\u0434\u0440\u0430\u0441", cidrv4: "IPv4 \u0434\u044B\u044F\u043F\u0430\u0437\u043E\u043D", cidrv6: "IPv6 \u0434\u044B\u044F\u043F\u0430\u0437\u043E\u043D", base64: "\u0440\u0430\u0434\u043E\u043A \u0443 \u0444\u0430\u0440\u043C\u0430\u0446\u0435 base64", base64url: "\u0440\u0430\u0434\u043E\u043A \u0443 \u0444\u0430\u0440\u043C\u0430\u0446\u0435 base64url", json_string: "JSON \u0440\u0430\u0434\u043E\u043A", e164: "\u043D\u0443\u043C\u0430\u0440 E.164", jwt: "JWT", template_literal: "\u0443\u0432\u043E\u0434" };
  return (n) => {
    switch (n.code) {
      case "invalid_type":
        return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u045E\u0432\u043E\u0434: \u0447\u0430\u043A\u0430\u045E\u0441\u044F ${n.expected}, \u0430\u0442\u0440\u044B\u043C\u0430\u043D\u0430 ${r(n.input)}`;
      case "invalid_value":
        if (n.values.length === 1) return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u045E\u0432\u043E\u0434: \u0447\u0430\u043A\u0430\u043B\u0430\u0441\u044F ${D(n.values[0])}`;
        return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u0432\u0430\u0440\u044B\u044F\u043D\u0442: \u0447\u0430\u043A\u0430\u045E\u0441\u044F \u0430\u0434\u0437\u0456\u043D \u0437 ${P(n.values, "|")}`;
      case "too_big": {
        let i = n.inclusive ? "<=" : "<", s = t(n.origin);
        if (s) {
          let a = Number(n.maximum), c = m$(a, s.unit.one, s.unit.few, s.unit.many);
          return `\u0417\u0430\u043D\u0430\u0434\u0442\u0430 \u0432\u044F\u043B\u0456\u043A\u0456: \u0447\u0430\u043A\u0430\u043B\u0430\u0441\u044F, \u0448\u0442\u043E ${n.origin ?? "\u0437\u043D\u0430\u0447\u044D\u043D\u043D\u0435"} \u043F\u0430\u0432\u0456\u043D\u043D\u0430 ${s.verb} ${i}${n.maximum.toString()} ${c}`;
        }
        return `\u0417\u0430\u043D\u0430\u0434\u0442\u0430 \u0432\u044F\u043B\u0456\u043A\u0456: \u0447\u0430\u043A\u0430\u043B\u0430\u0441\u044F, \u0448\u0442\u043E ${n.origin ?? "\u0437\u043D\u0430\u0447\u044D\u043D\u043D\u0435"} \u043F\u0430\u0432\u0456\u043D\u043D\u0430 \u0431\u044B\u0446\u044C ${i}${n.maximum.toString()}`;
      }
      case "too_small": {
        let i = n.inclusive ? ">=" : ">", s = t(n.origin);
        if (s) {
          let a = Number(n.minimum), c = m$(a, s.unit.one, s.unit.few, s.unit.many);
          return `\u0417\u0430\u043D\u0430\u0434\u0442\u0430 \u043C\u0430\u043B\u044B: \u0447\u0430\u043A\u0430\u043B\u0430\u0441\u044F, \u0448\u0442\u043E ${n.origin} \u043F\u0430\u0432\u0456\u043D\u043D\u0430 ${s.verb} ${i}${n.minimum.toString()} ${c}`;
        }
        return `\u0417\u0430\u043D\u0430\u0434\u0442\u0430 \u043C\u0430\u043B\u044B: \u0447\u0430\u043A\u0430\u043B\u0430\u0441\u044F, \u0448\u0442\u043E ${n.origin} \u043F\u0430\u0432\u0456\u043D\u043D\u0430 \u0431\u044B\u0446\u044C ${i}${n.minimum.toString()}`;
      }
      case "invalid_format": {
        let i = n;
        if (i.format === "starts_with") return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u0440\u0430\u0434\u043E\u043A: \u043F\u0430\u0432\u0456\u043D\u0435\u043D \u043F\u0430\u0447\u044B\u043D\u0430\u0446\u0446\u0430 \u0437 "${i.prefix}"`;
        if (i.format === "ends_with") return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u0440\u0430\u0434\u043E\u043A: \u043F\u0430\u0432\u0456\u043D\u0435\u043D \u0437\u0430\u043A\u0430\u043D\u0447\u0432\u0430\u0446\u0446\u0430 \u043D\u0430 "${i.suffix}"`;
        if (i.format === "includes") return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u0440\u0430\u0434\u043E\u043A: \u043F\u0430\u0432\u0456\u043D\u0435\u043D \u0437\u043C\u044F\u0448\u0447\u0430\u0446\u044C "${i.includes}"`;
        if (i.format === "regex") return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u0440\u0430\u0434\u043E\u043A: \u043F\u0430\u0432\u0456\u043D\u0435\u043D \u0430\u0434\u043F\u0430\u0432\u044F\u0434\u0430\u0446\u044C \u0448\u0430\u0431\u043B\u043E\u043D\u0443 ${i.pattern}`;
        return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B ${o[i.format] ?? n.format}`;
      }
      case "not_multiple_of":
        return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u043B\u0456\u043A: \u043F\u0430\u0432\u0456\u043D\u0435\u043D \u0431\u044B\u0446\u044C \u043A\u0440\u0430\u0442\u043D\u044B\u043C ${n.divisor}`;
      case "unrecognized_keys":
        return `\u041D\u0435\u0440\u0430\u0441\u043F\u0430\u0437\u043D\u0430\u043D\u044B ${n.keys.length > 1 ? "\u043A\u043B\u044E\u0447\u044B" : "\u043A\u043B\u044E\u0447"}: ${P(n.keys, ", ")}`;
      case "invalid_key":
        return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u043A\u043B\u044E\u0447 \u0443 ${n.origin}`;
      case "invalid_union":
        return "\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u045E\u0432\u043E\u0434";
      case "invalid_element":
        return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u0430\u0435 \u0437\u043D\u0430\u0447\u044D\u043D\u043D\u0435 \u045E ${n.origin}`;
      default:
        return "\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u045E\u0432\u043E\u0434";
    }
  };
};
function g_() {
  return { localeError: UZ() };
}
var zZ = () => {
  let e = { string: { unit: "car\xE0cters", verb: "contenir" }, file: { unit: "bytes", verb: "contenir" }, array: { unit: "elements", verb: "contenir" }, set: { unit: "elements", verb: "contenir" } };
  function t(n) {
    return e[n] ?? null;
  }
  let r = (n) => {
    let i = typeof n;
    switch (i) {
      case "number":
        return Number.isNaN(n) ? "NaN" : "number";
      case "object": {
        if (Array.isArray(n)) return "array";
        if (n === null) return "null";
        if (Object.getPrototypeOf(n) !== Object.prototype && n.constructor) return n.constructor.name;
      }
    }
    return i;
  }, o = { regex: "entrada", email: "adre\xE7a electr\xF2nica", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "data i hora ISO", date: "data ISO", time: "hora ISO", duration: "durada ISO", ipv4: "adre\xE7a IPv4", ipv6: "adre\xE7a IPv6", cidrv4: "rang IPv4", cidrv6: "rang IPv6", base64: "cadena codificada en base64", base64url: "cadena codificada en base64url", json_string: "cadena JSON", e164: "n\xFAmero E.164", jwt: "JWT", template_literal: "entrada" };
  return (n) => {
    switch (n.code) {
      case "invalid_type":
        return `Tipus inv\xE0lid: s'esperava ${n.expected}, s'ha rebut ${r(n.input)}`;
      case "invalid_value":
        if (n.values.length === 1) return `Valor inv\xE0lid: s'esperava ${D(n.values[0])}`;
        return `Opci\xF3 inv\xE0lida: s'esperava una de ${P(n.values, " o ")}`;
      case "too_big": {
        let i = n.inclusive ? "com a m\xE0xim" : "menys de", s = t(n.origin);
        if (s) return `Massa gran: s'esperava que ${n.origin ?? "el valor"} contingu\xE9s ${i} ${n.maximum.toString()} ${s.unit ?? "elements"}`;
        return `Massa gran: s'esperava que ${n.origin ?? "el valor"} fos ${i} ${n.maximum.toString()}`;
      }
      case "too_small": {
        let i = n.inclusive ? "com a m\xEDnim" : "m\xE9s de", s = t(n.origin);
        if (s) return `Massa petit: s'esperava que ${n.origin} contingu\xE9s ${i} ${n.minimum.toString()} ${s.unit}`;
        return `Massa petit: s'esperava que ${n.origin} fos ${i} ${n.minimum.toString()}`;
      }
      case "invalid_format": {
        let i = n;
        if (i.format === "starts_with") return `Format inv\xE0lid: ha de comen\xE7ar amb "${i.prefix}"`;
        if (i.format === "ends_with") return `Format inv\xE0lid: ha d'acabar amb "${i.suffix}"`;
        if (i.format === "includes") return `Format inv\xE0lid: ha d'incloure "${i.includes}"`;
        if (i.format === "regex") return `Format inv\xE0lid: ha de coincidir amb el patr\xF3 ${i.pattern}`;
        return `Format inv\xE0lid per a ${o[i.format] ?? n.format}`;
      }
      case "not_multiple_of":
        return `N\xFAmero inv\xE0lid: ha de ser m\xFAltiple de ${n.divisor}`;
      case "unrecognized_keys":
        return `Clau${n.keys.length > 1 ? "s" : ""} no reconeguda${n.keys.length > 1 ? "s" : ""}: ${P(n.keys, ", ")}`;
      case "invalid_key":
        return `Clau inv\xE0lida a ${n.origin}`;
      case "invalid_union":
        return "Entrada inv\xE0lida";
      case "invalid_element":
        return `Element inv\xE0lid a ${n.origin}`;
      default:
        return "Entrada inv\xE0lida";
    }
  };
};
function h_() {
  return { localeError: zZ() };
}
var LZ = () => {
  let e = { string: { unit: "znak\u016F", verb: "m\xEDt" }, file: { unit: "bajt\u016F", verb: "m\xEDt" }, array: { unit: "prvk\u016F", verb: "m\xEDt" }, set: { unit: "prvk\u016F", verb: "m\xEDt" } };
  function t(n) {
    return e[n] ?? null;
  }
  let r = (n) => {
    let i = typeof n;
    switch (i) {
      case "number":
        return Number.isNaN(n) ? "NaN" : "\u010D\xEDslo";
      case "string":
        return "\u0159et\u011Bzec";
      case "boolean":
        return "boolean";
      case "bigint":
        return "bigint";
      case "function":
        return "funkce";
      case "symbol":
        return "symbol";
      case "undefined":
        return "undefined";
      case "object": {
        if (Array.isArray(n)) return "pole";
        if (n === null) return "null";
        if (Object.getPrototypeOf(n) !== Object.prototype && n.constructor) return n.constructor.name;
      }
    }
    return i;
  }, o = { regex: "regul\xE1rn\xED v\xFDraz", email: "e-mailov\xE1 adresa", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "datum a \u010Das ve form\xE1tu ISO", date: "datum ve form\xE1tu ISO", time: "\u010Das ve form\xE1tu ISO", duration: "doba trv\xE1n\xED ISO", ipv4: "IPv4 adresa", ipv6: "IPv6 adresa", cidrv4: "rozsah IPv4", cidrv6: "rozsah IPv6", base64: "\u0159et\u011Bzec zak\xF3dovan\xFD ve form\xE1tu base64", base64url: "\u0159et\u011Bzec zak\xF3dovan\xFD ve form\xE1tu base64url", json_string: "\u0159et\u011Bzec ve form\xE1tu JSON", e164: "\u010D\xEDslo E.164", jwt: "JWT", template_literal: "vstup" };
  return (n) => {
    switch (n.code) {
      case "invalid_type":
        return `Neplatn\xFD vstup: o\u010Dek\xE1v\xE1no ${n.expected}, obdr\u017Eeno ${r(n.input)}`;
      case "invalid_value":
        if (n.values.length === 1) return `Neplatn\xFD vstup: o\u010Dek\xE1v\xE1no ${D(n.values[0])}`;
        return `Neplatn\xE1 mo\u017Enost: o\u010Dek\xE1v\xE1na jedna z hodnot ${P(n.values, "|")}`;
      case "too_big": {
        let i = n.inclusive ? "<=" : "<", s = t(n.origin);
        if (s) return `Hodnota je p\u0159\xEDli\u0161 velk\xE1: ${n.origin ?? "hodnota"} mus\xED m\xEDt ${i}${n.maximum.toString()} ${s.unit ?? "prvk\u016F"}`;
        return `Hodnota je p\u0159\xEDli\u0161 velk\xE1: ${n.origin ?? "hodnota"} mus\xED b\xFDt ${i}${n.maximum.toString()}`;
      }
      case "too_small": {
        let i = n.inclusive ? ">=" : ">", s = t(n.origin);
        if (s) return `Hodnota je p\u0159\xEDli\u0161 mal\xE1: ${n.origin ?? "hodnota"} mus\xED m\xEDt ${i}${n.minimum.toString()} ${s.unit ?? "prvk\u016F"}`;
        return `Hodnota je p\u0159\xEDli\u0161 mal\xE1: ${n.origin ?? "hodnota"} mus\xED b\xFDt ${i}${n.minimum.toString()}`;
      }
      case "invalid_format": {
        let i = n;
        if (i.format === "starts_with") return `Neplatn\xFD \u0159et\u011Bzec: mus\xED za\u010D\xEDnat na "${i.prefix}"`;
        if (i.format === "ends_with") return `Neplatn\xFD \u0159et\u011Bzec: mus\xED kon\u010Dit na "${i.suffix}"`;
        if (i.format === "includes") return `Neplatn\xFD \u0159et\u011Bzec: mus\xED obsahovat "${i.includes}"`;
        if (i.format === "regex") return `Neplatn\xFD \u0159et\u011Bzec: mus\xED odpov\xEDdat vzoru ${i.pattern}`;
        return `Neplatn\xFD form\xE1t ${o[i.format] ?? n.format}`;
      }
      case "not_multiple_of":
        return `Neplatn\xE9 \u010D\xEDslo: mus\xED b\xFDt n\xE1sobkem ${n.divisor}`;
      case "unrecognized_keys":
        return `Nezn\xE1m\xE9 kl\xED\u010De: ${P(n.keys, ", ")}`;
      case "invalid_key":
        return `Neplatn\xFD kl\xED\u010D v ${n.origin}`;
      case "invalid_union":
        return "Neplatn\xFD vstup";
      case "invalid_element":
        return `Neplatn\xE1 hodnota v ${n.origin}`;
      default:
        return "Neplatn\xFD vstup";
    }
  };
};
function y_() {
  return { localeError: LZ() };
}
var FZ = () => {
  let e = { string: { unit: "Zeichen", verb: "zu haben" }, file: { unit: "Bytes", verb: "zu haben" }, array: { unit: "Elemente", verb: "zu haben" }, set: { unit: "Elemente", verb: "zu haben" } };
  function t(n) {
    return e[n] ?? null;
  }
  let r = (n) => {
    let i = typeof n;
    switch (i) {
      case "number":
        return Number.isNaN(n) ? "NaN" : "Zahl";
      case "object": {
        if (Array.isArray(n)) return "Array";
        if (n === null) return "null";
        if (Object.getPrototypeOf(n) !== Object.prototype && n.constructor) return n.constructor.name;
      }
    }
    return i;
  }, o = { regex: "Eingabe", email: "E-Mail-Adresse", url: "URL", emoji: "Emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO-Datum und -Uhrzeit", date: "ISO-Datum", time: "ISO-Uhrzeit", duration: "ISO-Dauer", ipv4: "IPv4-Adresse", ipv6: "IPv6-Adresse", cidrv4: "IPv4-Bereich", cidrv6: "IPv6-Bereich", base64: "Base64-codierter String", base64url: "Base64-URL-codierter String", json_string: "JSON-String", e164: "E.164-Nummer", jwt: "JWT", template_literal: "Eingabe" };
  return (n) => {
    switch (n.code) {
      case "invalid_type":
        return `Ung\xFCltige Eingabe: erwartet ${n.expected}, erhalten ${r(n.input)}`;
      case "invalid_value":
        if (n.values.length === 1) return `Ung\xFCltige Eingabe: erwartet ${D(n.values[0])}`;
        return `Ung\xFCltige Option: erwartet eine von ${P(n.values, "|")}`;
      case "too_big": {
        let i = n.inclusive ? "<=" : "<", s = t(n.origin);
        if (s) return `Zu gro\xDF: erwartet, dass ${n.origin ?? "Wert"} ${i}${n.maximum.toString()} ${s.unit ?? "Elemente"} hat`;
        return `Zu gro\xDF: erwartet, dass ${n.origin ?? "Wert"} ${i}${n.maximum.toString()} ist`;
      }
      case "too_small": {
        let i = n.inclusive ? ">=" : ">", s = t(n.origin);
        if (s) return `Zu klein: erwartet, dass ${n.origin} ${i}${n.minimum.toString()} ${s.unit} hat`;
        return `Zu klein: erwartet, dass ${n.origin} ${i}${n.minimum.toString()} ist`;
      }
      case "invalid_format": {
        let i = n;
        if (i.format === "starts_with") return `Ung\xFCltiger String: muss mit "${i.prefix}" beginnen`;
        if (i.format === "ends_with") return `Ung\xFCltiger String: muss mit "${i.suffix}" enden`;
        if (i.format === "includes") return `Ung\xFCltiger String: muss "${i.includes}" enthalten`;
        if (i.format === "regex") return `Ung\xFCltiger String: muss dem Muster ${i.pattern} entsprechen`;
        return `Ung\xFCltig: ${o[i.format] ?? n.format}`;
      }
      case "not_multiple_of":
        return `Ung\xFCltige Zahl: muss ein Vielfaches von ${n.divisor} sein`;
      case "unrecognized_keys":
        return `${n.keys.length > 1 ? "Unbekannte Schl\xFCssel" : "Unbekannter Schl\xFCssel"}: ${P(n.keys, ", ")}`;
      case "invalid_key":
        return `Ung\xFCltiger Schl\xFCssel in ${n.origin}`;
      case "invalid_union":
        return "Ung\xFCltige Eingabe";
      case "invalid_element":
        return `Ung\xFCltiger Wert in ${n.origin}`;
      default:
        return "Ung\xFCltige Eingabe";
    }
  };
};
function b_() {
  return { localeError: FZ() };
}
var HZ = (e) => {
  let t = typeof e;
  switch (t) {
    case "number":
      return Number.isNaN(e) ? "NaN" : "number";
    case "object": {
      if (Array.isArray(e)) return "array";
      if (e === null) return "null";
      if (Object.getPrototypeOf(e) !== Object.prototype && e.constructor) return e.constructor.name;
    }
  }
  return t;
};
var BZ = () => {
  let e = { string: { unit: "characters", verb: "to have" }, file: { unit: "bytes", verb: "to have" }, array: { unit: "items", verb: "to have" }, set: { unit: "items", verb: "to have" } };
  function t(o) {
    return e[o] ?? null;
  }
  let r = { regex: "input", email: "email address", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO datetime", date: "ISO date", time: "ISO time", duration: "ISO duration", ipv4: "IPv4 address", ipv6: "IPv6 address", cidrv4: "IPv4 range", cidrv6: "IPv6 range", base64: "base64-encoded string", base64url: "base64url-encoded string", json_string: "JSON string", e164: "E.164 number", jwt: "JWT", template_literal: "input" };
  return (o) => {
    switch (o.code) {
      case "invalid_type":
        return `Invalid input: expected ${o.expected}, received ${HZ(o.input)}`;
      case "invalid_value":
        if (o.values.length === 1) return `Invalid input: expected ${D(o.values[0])}`;
        return `Invalid option: expected one of ${P(o.values, "|")}`;
      case "too_big": {
        let n = o.inclusive ? "<=" : "<", i = t(o.origin);
        if (i) return `Too big: expected ${o.origin ?? "value"} to have ${n}${o.maximum.toString()} ${i.unit ?? "elements"}`;
        return `Too big: expected ${o.origin ?? "value"} to be ${n}${o.maximum.toString()}`;
      }
      case "too_small": {
        let n = o.inclusive ? ">=" : ">", i = t(o.origin);
        if (i) return `Too small: expected ${o.origin} to have ${n}${o.minimum.toString()} ${i.unit}`;
        return `Too small: expected ${o.origin} to be ${n}${o.minimum.toString()}`;
      }
      case "invalid_format": {
        let n = o;
        if (n.format === "starts_with") return `Invalid string: must start with "${n.prefix}"`;
        if (n.format === "ends_with") return `Invalid string: must end with "${n.suffix}"`;
        if (n.format === "includes") return `Invalid string: must include "${n.includes}"`;
        if (n.format === "regex") return `Invalid string: must match pattern ${n.pattern}`;
        return `Invalid ${r[n.format] ?? o.format}`;
      }
      case "not_multiple_of":
        return `Invalid number: must be a multiple of ${o.divisor}`;
      case "unrecognized_keys":
        return `Unrecognized key${o.keys.length > 1 ? "s" : ""}: ${P(o.keys, ", ")}`;
      case "invalid_key":
        return `Invalid key in ${o.origin}`;
      case "invalid_union":
        return "Invalid input";
      case "invalid_element":
        return `Invalid value in ${o.origin}`;
      default:
        return "Invalid input";
    }
  };
};
function Nc() {
  return { localeError: BZ() };
}
var qZ = (e) => {
  let t = typeof e;
  switch (t) {
    case "number":
      return Number.isNaN(e) ? "NaN" : "nombro";
    case "object": {
      if (Array.isArray(e)) return "tabelo";
      if (e === null) return "senvalora";
      if (Object.getPrototypeOf(e) !== Object.prototype && e.constructor) return e.constructor.name;
    }
  }
  return t;
};
var VZ = () => {
  let e = { string: { unit: "karaktrojn", verb: "havi" }, file: { unit: "bajtojn", verb: "havi" }, array: { unit: "elementojn", verb: "havi" }, set: { unit: "elementojn", verb: "havi" } };
  function t(o) {
    return e[o] ?? null;
  }
  let r = { regex: "enigo", email: "retadreso", url: "URL", emoji: "emo\u011Dio", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO-datotempo", date: "ISO-dato", time: "ISO-tempo", duration: "ISO-da\u016Dro", ipv4: "IPv4-adreso", ipv6: "IPv6-adreso", cidrv4: "IPv4-rango", cidrv6: "IPv6-rango", base64: "64-ume kodita karaktraro", base64url: "URL-64-ume kodita karaktraro", json_string: "JSON-karaktraro", e164: "E.164-nombro", jwt: "JWT", template_literal: "enigo" };
  return (o) => {
    switch (o.code) {
      case "invalid_type":
        return `Nevalida enigo: atendi\u011Dis ${o.expected}, ricevi\u011Dis ${qZ(o.input)}`;
      case "invalid_value":
        if (o.values.length === 1) return `Nevalida enigo: atendi\u011Dis ${D(o.values[0])}`;
        return `Nevalida opcio: atendi\u011Dis unu el ${P(o.values, "|")}`;
      case "too_big": {
        let n = o.inclusive ? "<=" : "<", i = t(o.origin);
        if (i) return `Tro granda: atendi\u011Dis ke ${o.origin ?? "valoro"} havu ${n}${o.maximum.toString()} ${i.unit ?? "elementojn"}`;
        return `Tro granda: atendi\u011Dis ke ${o.origin ?? "valoro"} havu ${n}${o.maximum.toString()}`;
      }
      case "too_small": {
        let n = o.inclusive ? ">=" : ">", i = t(o.origin);
        if (i) return `Tro malgranda: atendi\u011Dis ke ${o.origin} havu ${n}${o.minimum.toString()} ${i.unit}`;
        return `Tro malgranda: atendi\u011Dis ke ${o.origin} estu ${n}${o.minimum.toString()}`;
      }
      case "invalid_format": {
        let n = o;
        if (n.format === "starts_with") return `Nevalida karaktraro: devas komenci\u011Di per "${n.prefix}"`;
        if (n.format === "ends_with") return `Nevalida karaktraro: devas fini\u011Di per "${n.suffix}"`;
        if (n.format === "includes") return `Nevalida karaktraro: devas inkluzivi "${n.includes}"`;
        if (n.format === "regex") return `Nevalida karaktraro: devas kongrui kun la modelo ${n.pattern}`;
        return `Nevalida ${r[n.format] ?? o.format}`;
      }
      case "not_multiple_of":
        return `Nevalida nombro: devas esti oblo de ${o.divisor}`;
      case "unrecognized_keys":
        return `Nekonata${o.keys.length > 1 ? "j" : ""} \u015Dlosilo${o.keys.length > 1 ? "j" : ""}: ${P(o.keys, ", ")}`;
      case "invalid_key":
        return `Nevalida \u015Dlosilo en ${o.origin}`;
      case "invalid_union":
        return "Nevalida enigo";
      case "invalid_element":
        return `Nevalida valoro en ${o.origin}`;
      default:
        return "Nevalida enigo";
    }
  };
};
function __() {
  return { localeError: VZ() };
}
var ZZ = () => {
  let e = { string: { unit: "caracteres", verb: "tener" }, file: { unit: "bytes", verb: "tener" }, array: { unit: "elementos", verb: "tener" }, set: { unit: "elementos", verb: "tener" } };
  function t(n) {
    return e[n] ?? null;
  }
  let r = (n) => {
    let i = typeof n;
    switch (i) {
      case "number":
        return Number.isNaN(n) ? "NaN" : "n\xFAmero";
      case "object": {
        if (Array.isArray(n)) return "arreglo";
        if (n === null) return "nulo";
        if (Object.getPrototypeOf(n) !== Object.prototype) return n.constructor.name;
      }
    }
    return i;
  }, o = { regex: "entrada", email: "direcci\xF3n de correo electr\xF3nico", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "fecha y hora ISO", date: "fecha ISO", time: "hora ISO", duration: "duraci\xF3n ISO", ipv4: "direcci\xF3n IPv4", ipv6: "direcci\xF3n IPv6", cidrv4: "rango IPv4", cidrv6: "rango IPv6", base64: "cadena codificada en base64", base64url: "URL codificada en base64", json_string: "cadena JSON", e164: "n\xFAmero E.164", jwt: "JWT", template_literal: "entrada" };
  return (n) => {
    switch (n.code) {
      case "invalid_type":
        return `Entrada inv\xE1lida: se esperaba ${n.expected}, recibido ${r(n.input)}`;
      case "invalid_value":
        if (n.values.length === 1) return `Entrada inv\xE1lida: se esperaba ${D(n.values[0])}`;
        return `Opci\xF3n inv\xE1lida: se esperaba una de ${P(n.values, "|")}`;
      case "too_big": {
        let i = n.inclusive ? "<=" : "<", s = t(n.origin);
        if (s) return `Demasiado grande: se esperaba que ${n.origin ?? "valor"} tuviera ${i}${n.maximum.toString()} ${s.unit ?? "elementos"}`;
        return `Demasiado grande: se esperaba que ${n.origin ?? "valor"} fuera ${i}${n.maximum.toString()}`;
      }
      case "too_small": {
        let i = n.inclusive ? ">=" : ">", s = t(n.origin);
        if (s) return `Demasiado peque\xF1o: se esperaba que ${n.origin} tuviera ${i}${n.minimum.toString()} ${s.unit}`;
        return `Demasiado peque\xF1o: se esperaba que ${n.origin} fuera ${i}${n.minimum.toString()}`;
      }
      case "invalid_format": {
        let i = n;
        if (i.format === "starts_with") return `Cadena inv\xE1lida: debe comenzar con "${i.prefix}"`;
        if (i.format === "ends_with") return `Cadena inv\xE1lida: debe terminar en "${i.suffix}"`;
        if (i.format === "includes") return `Cadena inv\xE1lida: debe incluir "${i.includes}"`;
        if (i.format === "regex") return `Cadena inv\xE1lida: debe coincidir con el patr\xF3n ${i.pattern}`;
        return `Inv\xE1lido ${o[i.format] ?? n.format}`;
      }
      case "not_multiple_of":
        return `N\xFAmero inv\xE1lido: debe ser m\xFAltiplo de ${n.divisor}`;
      case "unrecognized_keys":
        return `Llave${n.keys.length > 1 ? "s" : ""} desconocida${n.keys.length > 1 ? "s" : ""}: ${P(n.keys, ", ")}`;
      case "invalid_key":
        return `Llave inv\xE1lida en ${n.origin}`;
      case "invalid_union":
        return "Entrada inv\xE1lida";
      case "invalid_element":
        return `Valor inv\xE1lido en ${n.origin}`;
      default:
        return "Entrada inv\xE1lida";
    }
  };
};
function v_() {
  return { localeError: ZZ() };
}
var WZ = () => {
  let e = { string: { unit: "\u06A9\u0627\u0631\u0627\u06A9\u062A\u0631", verb: "\u062F\u0627\u0634\u062A\u0647 \u0628\u0627\u0634\u062F" }, file: { unit: "\u0628\u0627\u06CC\u062A", verb: "\u062F\u0627\u0634\u062A\u0647 \u0628\u0627\u0634\u062F" }, array: { unit: "\u0622\u06CC\u062A\u0645", verb: "\u062F\u0627\u0634\u062A\u0647 \u0628\u0627\u0634\u062F" }, set: { unit: "\u0622\u06CC\u062A\u0645", verb: "\u062F\u0627\u0634\u062A\u0647 \u0628\u0627\u0634\u062F" } };
  function t(n) {
    return e[n] ?? null;
  }
  let r = (n) => {
    let i = typeof n;
    switch (i) {
      case "number":
        return Number.isNaN(n) ? "NaN" : "\u0639\u062F\u062F";
      case "object": {
        if (Array.isArray(n)) return "\u0622\u0631\u0627\u06CC\u0647";
        if (n === null) return "null";
        if (Object.getPrototypeOf(n) !== Object.prototype && n.constructor) return n.constructor.name;
      }
    }
    return i;
  }, o = { regex: "\u0648\u0631\u0648\u062F\u06CC", email: "\u0622\u062F\u0631\u0633 \u0627\u06CC\u0645\u06CC\u0644", url: "URL", emoji: "\u0627\u06CC\u0645\u0648\u062C\u06CC", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "\u062A\u0627\u0631\u06CC\u062E \u0648 \u0632\u0645\u0627\u0646 \u0627\u06CC\u0632\u0648", date: "\u062A\u0627\u0631\u06CC\u062E \u0627\u06CC\u0632\u0648", time: "\u0632\u0645\u0627\u0646 \u0627\u06CC\u0632\u0648", duration: "\u0645\u062F\u062A \u0632\u0645\u0627\u0646 \u0627\u06CC\u0632\u0648", ipv4: "IPv4 \u0622\u062F\u0631\u0633", ipv6: "IPv6 \u0622\u062F\u0631\u0633", cidrv4: "IPv4 \u062F\u0627\u0645\u0646\u0647", cidrv6: "IPv6 \u062F\u0627\u0645\u0646\u0647", base64: "base64-encoded \u0631\u0634\u062A\u0647", base64url: "base64url-encoded \u0631\u0634\u062A\u0647", json_string: "JSON \u0631\u0634\u062A\u0647", e164: "E.164 \u0639\u062F\u062F", jwt: "JWT", template_literal: "\u0648\u0631\u0648\u062F\u06CC" };
  return (n) => {
    switch (n.code) {
      case "invalid_type":
        return `\u0648\u0631\u0648\u062F\u06CC \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0645\u06CC\u200C\u0628\u0627\u06CC\u0633\u062A ${n.expected} \u0645\u06CC\u200C\u0628\u0648\u062F\u060C ${r(n.input)} \u062F\u0631\u06CC\u0627\u0641\u062A \u0634\u062F`;
      case "invalid_value":
        if (n.values.length === 1) return `\u0648\u0631\u0648\u062F\u06CC \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0645\u06CC\u200C\u0628\u0627\u06CC\u0633\u062A ${D(n.values[0])} \u0645\u06CC\u200C\u0628\u0648\u062F`;
        return `\u06AF\u0632\u06CC\u0646\u0647 \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0645\u06CC\u200C\u0628\u0627\u06CC\u0633\u062A \u06CC\u06A9\u06CC \u0627\u0632 ${P(n.values, "|")} \u0645\u06CC\u200C\u0628\u0648\u062F`;
      case "too_big": {
        let i = n.inclusive ? "<=" : "<", s = t(n.origin);
        if (s) return `\u062E\u06CC\u0644\u06CC \u0628\u0632\u0631\u06AF: ${n.origin ?? "\u0645\u0642\u062F\u0627\u0631"} \u0628\u0627\u06CC\u062F ${i}${n.maximum.toString()} ${s.unit ?? "\u0639\u0646\u0635\u0631"} \u0628\u0627\u0634\u062F`;
        return `\u062E\u06CC\u0644\u06CC \u0628\u0632\u0631\u06AF: ${n.origin ?? "\u0645\u0642\u062F\u0627\u0631"} \u0628\u0627\u06CC\u062F ${i}${n.maximum.toString()} \u0628\u0627\u0634\u062F`;
      }
      case "too_small": {
        let i = n.inclusive ? ">=" : ">", s = t(n.origin);
        if (s) return `\u062E\u06CC\u0644\u06CC \u06A9\u0648\u0686\u06A9: ${n.origin} \u0628\u0627\u06CC\u062F ${i}${n.minimum.toString()} ${s.unit} \u0628\u0627\u0634\u062F`;
        return `\u062E\u06CC\u0644\u06CC \u06A9\u0648\u0686\u06A9: ${n.origin} \u0628\u0627\u06CC\u062F ${i}${n.minimum.toString()} \u0628\u0627\u0634\u062F`;
      }
      case "invalid_format": {
        let i = n;
        if (i.format === "starts_with") return `\u0631\u0634\u062A\u0647 \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0628\u0627\u06CC\u062F \u0628\u0627 "${i.prefix}" \u0634\u0631\u0648\u0639 \u0634\u0648\u062F`;
        if (i.format === "ends_with") return `\u0631\u0634\u062A\u0647 \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0628\u0627\u06CC\u062F \u0628\u0627 "${i.suffix}" \u062A\u0645\u0627\u0645 \u0634\u0648\u062F`;
        if (i.format === "includes") return `\u0631\u0634\u062A\u0647 \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0628\u0627\u06CC\u062F \u0634\u0627\u0645\u0644 "${i.includes}" \u0628\u0627\u0634\u062F`;
        if (i.format === "regex") return `\u0631\u0634\u062A\u0647 \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0628\u0627\u06CC\u062F \u0628\u0627 \u0627\u0644\u06AF\u0648\u06CC ${i.pattern} \u0645\u0637\u0627\u0628\u0642\u062A \u062F\u0627\u0634\u062A\u0647 \u0628\u0627\u0634\u062F`;
        return `${o[i.format] ?? n.format} \u0646\u0627\u0645\u0639\u062A\u0628\u0631`;
      }
      case "not_multiple_of":
        return `\u0639\u062F\u062F \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0628\u0627\u06CC\u062F \u0645\u0636\u0631\u0628 ${n.divisor} \u0628\u0627\u0634\u062F`;
      case "unrecognized_keys":
        return `\u06A9\u0644\u06CC\u062F${n.keys.length > 1 ? "\u0647\u0627\u06CC" : ""} \u0646\u0627\u0634\u0646\u0627\u0633: ${P(n.keys, ", ")}`;
      case "invalid_key":
        return `\u06A9\u0644\u06CC\u062F \u0646\u0627\u0634\u0646\u0627\u0633 \u062F\u0631 ${n.origin}`;
      case "invalid_union":
        return "\u0648\u0631\u0648\u062F\u06CC \u0646\u0627\u0645\u0639\u062A\u0628\u0631";
      case "invalid_element":
        return `\u0645\u0642\u062F\u0627\u0631 \u0646\u0627\u0645\u0639\u062A\u0628\u0631 \u062F\u0631 ${n.origin}`;
      default:
        return "\u0648\u0631\u0648\u062F\u06CC \u0646\u0627\u0645\u0639\u062A\u0628\u0631";
    }
  };
};
function S_() {
  return { localeError: WZ() };
}
var KZ = () => {
  let e = { string: { unit: "merkki\xE4", subject: "merkkijonon" }, file: { unit: "tavua", subject: "tiedoston" }, array: { unit: "alkiota", subject: "listan" }, set: { unit: "alkiota", subject: "joukon" }, number: { unit: "", subject: "luvun" }, bigint: { unit: "", subject: "suuren kokonaisluvun" }, int: { unit: "", subject: "kokonaisluvun" }, date: { unit: "", subject: "p\xE4iv\xE4m\xE4\xE4r\xE4n" } };
  function t(n) {
    return e[n] ?? null;
  }
  let r = (n) => {
    let i = typeof n;
    switch (i) {
      case "number":
        return Number.isNaN(n) ? "NaN" : "number";
      case "object": {
        if (Array.isArray(n)) return "array";
        if (n === null) return "null";
        if (Object.getPrototypeOf(n) !== Object.prototype && n.constructor) return n.constructor.name;
      }
    }
    return i;
  }, o = { regex: "s\xE4\xE4nn\xF6llinen lauseke", email: "s\xE4hk\xF6postiosoite", url: "URL-osoite", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO-aikaleima", date: "ISO-p\xE4iv\xE4m\xE4\xE4r\xE4", time: "ISO-aika", duration: "ISO-kesto", ipv4: "IPv4-osoite", ipv6: "IPv6-osoite", cidrv4: "IPv4-alue", cidrv6: "IPv6-alue", base64: "base64-koodattu merkkijono", base64url: "base64url-koodattu merkkijono", json_string: "JSON-merkkijono", e164: "E.164-luku", jwt: "JWT", template_literal: "templaattimerkkijono" };
  return (n) => {
    switch (n.code) {
      case "invalid_type":
        return `Virheellinen tyyppi: odotettiin ${n.expected}, oli ${r(n.input)}`;
      case "invalid_value":
        if (n.values.length === 1) return `Virheellinen sy\xF6te: t\xE4ytyy olla ${D(n.values[0])}`;
        return `Virheellinen valinta: t\xE4ytyy olla yksi seuraavista: ${P(n.values, "|")}`;
      case "too_big": {
        let i = n.inclusive ? "<=" : "<", s = t(n.origin);
        if (s) return `Liian suuri: ${s.subject} t\xE4ytyy olla ${i}${n.maximum.toString()} ${s.unit}`.trim();
        return `Liian suuri: arvon t\xE4ytyy olla ${i}${n.maximum.toString()}`;
      }
      case "too_small": {
        let i = n.inclusive ? ">=" : ">", s = t(n.origin);
        if (s) return `Liian pieni: ${s.subject} t\xE4ytyy olla ${i}${n.minimum.toString()} ${s.unit}`.trim();
        return `Liian pieni: arvon t\xE4ytyy olla ${i}${n.minimum.toString()}`;
      }
      case "invalid_format": {
        let i = n;
        if (i.format === "starts_with") return `Virheellinen sy\xF6te: t\xE4ytyy alkaa "${i.prefix}"`;
        if (i.format === "ends_with") return `Virheellinen sy\xF6te: t\xE4ytyy loppua "${i.suffix}"`;
        if (i.format === "includes") return `Virheellinen sy\xF6te: t\xE4ytyy sis\xE4lt\xE4\xE4 "${i.includes}"`;
        if (i.format === "regex") return `Virheellinen sy\xF6te: t\xE4ytyy vastata s\xE4\xE4nn\xF6llist\xE4 lauseketta ${i.pattern}`;
        return `Virheellinen ${o[i.format] ?? n.format}`;
      }
      case "not_multiple_of":
        return `Virheellinen luku: t\xE4ytyy olla luvun ${n.divisor} monikerta`;
      case "unrecognized_keys":
        return `${n.keys.length > 1 ? "Tuntemattomat avaimet" : "Tuntematon avain"}: ${P(n.keys, ", ")}`;
      case "invalid_key":
        return "Virheellinen avain tietueessa";
      case "invalid_union":
        return "Virheellinen unioni";
      case "invalid_element":
        return "Virheellinen arvo joukossa";
      default:
        return "Virheellinen sy\xF6te";
    }
  };
};
function x_() {
  return { localeError: KZ() };
}
var GZ = () => {
  let e = { string: { unit: "caract\xE8res", verb: "avoir" }, file: { unit: "octets", verb: "avoir" }, array: { unit: "\xE9l\xE9ments", verb: "avoir" }, set: { unit: "\xE9l\xE9ments", verb: "avoir" } };
  function t(n) {
    return e[n] ?? null;
  }
  let r = (n) => {
    let i = typeof n;
    switch (i) {
      case "number":
        return Number.isNaN(n) ? "NaN" : "nombre";
      case "object": {
        if (Array.isArray(n)) return "tableau";
        if (n === null) return "null";
        if (Object.getPrototypeOf(n) !== Object.prototype && n.constructor) return n.constructor.name;
      }
    }
    return i;
  }, o = { regex: "entr\xE9e", email: "adresse e-mail", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "date et heure ISO", date: "date ISO", time: "heure ISO", duration: "dur\xE9e ISO", ipv4: "adresse IPv4", ipv6: "adresse IPv6", cidrv4: "plage IPv4", cidrv6: "plage IPv6", base64: "cha\xEEne encod\xE9e en base64", base64url: "cha\xEEne encod\xE9e en base64url", json_string: "cha\xEEne JSON", e164: "num\xE9ro E.164", jwt: "JWT", template_literal: "entr\xE9e" };
  return (n) => {
    switch (n.code) {
      case "invalid_type":
        return `Entr\xE9e invalide : ${n.expected} attendu, ${r(n.input)} re\xE7u`;
      case "invalid_value":
        if (n.values.length === 1) return `Entr\xE9e invalide : ${D(n.values[0])} attendu`;
        return `Option invalide : une valeur parmi ${P(n.values, "|")} attendue`;
      case "too_big": {
        let i = n.inclusive ? "<=" : "<", s = t(n.origin);
        if (s) return `Trop grand : ${n.origin ?? "valeur"} doit ${s.verb} ${i}${n.maximum.toString()} ${s.unit ?? "\xE9l\xE9ment(s)"}`;
        return `Trop grand : ${n.origin ?? "valeur"} doit \xEAtre ${i}${n.maximum.toString()}`;
      }
      case "too_small": {
        let i = n.inclusive ? ">=" : ">", s = t(n.origin);
        if (s) return `Trop petit : ${n.origin} doit ${s.verb} ${i}${n.minimum.toString()} ${s.unit}`;
        return `Trop petit : ${n.origin} doit \xEAtre ${i}${n.minimum.toString()}`;
      }
      case "invalid_format": {
        let i = n;
        if (i.format === "starts_with") return `Cha\xEEne invalide : doit commencer par "${i.prefix}"`;
        if (i.format === "ends_with") return `Cha\xEEne invalide : doit se terminer par "${i.suffix}"`;
        if (i.format === "includes") return `Cha\xEEne invalide : doit inclure "${i.includes}"`;
        if (i.format === "regex") return `Cha\xEEne invalide : doit correspondre au mod\xE8le ${i.pattern}`;
        return `${o[i.format] ?? n.format} invalide`;
      }
      case "not_multiple_of":
        return `Nombre invalide : doit \xEAtre un multiple de ${n.divisor}`;
      case "unrecognized_keys":
        return `Cl\xE9${n.keys.length > 1 ? "s" : ""} non reconnue${n.keys.length > 1 ? "s" : ""} : ${P(n.keys, ", ")}`;
      case "invalid_key":
        return `Cl\xE9 invalide dans ${n.origin}`;
      case "invalid_union":
        return "Entr\xE9e invalide";
      case "invalid_element":
        return `Valeur invalide dans ${n.origin}`;
      default:
        return "Entr\xE9e invalide";
    }
  };
};
function w_() {
  return { localeError: GZ() };
}
var JZ = () => {
  let e = { string: { unit: "caract\xE8res", verb: "avoir" }, file: { unit: "octets", verb: "avoir" }, array: { unit: "\xE9l\xE9ments", verb: "avoir" }, set: { unit: "\xE9l\xE9ments", verb: "avoir" } };
  function t(n) {
    return e[n] ?? null;
  }
  let r = (n) => {
    let i = typeof n;
    switch (i) {
      case "number":
        return Number.isNaN(n) ? "NaN" : "number";
      case "object": {
        if (Array.isArray(n)) return "array";
        if (n === null) return "null";
        if (Object.getPrototypeOf(n) !== Object.prototype && n.constructor) return n.constructor.name;
      }
    }
    return i;
  }, o = { regex: "entr\xE9e", email: "adresse courriel", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "date-heure ISO", date: "date ISO", time: "heure ISO", duration: "dur\xE9e ISO", ipv4: "adresse IPv4", ipv6: "adresse IPv6", cidrv4: "plage IPv4", cidrv6: "plage IPv6", base64: "cha\xEEne encod\xE9e en base64", base64url: "cha\xEEne encod\xE9e en base64url", json_string: "cha\xEEne JSON", e164: "num\xE9ro E.164", jwt: "JWT", template_literal: "entr\xE9e" };
  return (n) => {
    switch (n.code) {
      case "invalid_type":
        return `Entr\xE9e invalide : attendu ${n.expected}, re\xE7u ${r(n.input)}`;
      case "invalid_value":
        if (n.values.length === 1) return `Entr\xE9e invalide : attendu ${D(n.values[0])}`;
        return `Option invalide : attendu l'une des valeurs suivantes ${P(n.values, "|")}`;
      case "too_big": {
        let i = n.inclusive ? "\u2264" : "<", s = t(n.origin);
        if (s) return `Trop grand : attendu que ${n.origin ?? "la valeur"} ait ${i}${n.maximum.toString()} ${s.unit}`;
        return `Trop grand : attendu que ${n.origin ?? "la valeur"} soit ${i}${n.maximum.toString()}`;
      }
      case "too_small": {
        let i = n.inclusive ? "\u2265" : ">", s = t(n.origin);
        if (s) return `Trop petit : attendu que ${n.origin} ait ${i}${n.minimum.toString()} ${s.unit}`;
        return `Trop petit : attendu que ${n.origin} soit ${i}${n.minimum.toString()}`;
      }
      case "invalid_format": {
        let i = n;
        if (i.format === "starts_with") return `Cha\xEEne invalide : doit commencer par "${i.prefix}"`;
        if (i.format === "ends_with") return `Cha\xEEne invalide : doit se terminer par "${i.suffix}"`;
        if (i.format === "includes") return `Cha\xEEne invalide : doit inclure "${i.includes}"`;
        if (i.format === "regex") return `Cha\xEEne invalide : doit correspondre au motif ${i.pattern}`;
        return `${o[i.format] ?? n.format} invalide`;
      }
      case "not_multiple_of":
        return `Nombre invalide : doit \xEAtre un multiple de ${n.divisor}`;
      case "unrecognized_keys":
        return `Cl\xE9${n.keys.length > 1 ? "s" : ""} non reconnue${n.keys.length > 1 ? "s" : ""} : ${P(n.keys, ", ")}`;
      case "invalid_key":
        return `Cl\xE9 invalide dans ${n.origin}`;
      case "invalid_union":
        return "Entr\xE9e invalide";
      case "invalid_element":
        return `Valeur invalide dans ${n.origin}`;
      default:
        return "Entr\xE9e invalide";
    }
  };
};
function k_() {
  return { localeError: JZ() };
}
var XZ = () => {
  let e = { string: { unit: "\u05D0\u05D5\u05EA\u05D9\u05D5\u05EA", verb: "\u05DC\u05DB\u05DC\u05D5\u05DC" }, file: { unit: "\u05D1\u05D9\u05D9\u05D8\u05D9\u05DD", verb: "\u05DC\u05DB\u05DC\u05D5\u05DC" }, array: { unit: "\u05E4\u05E8\u05D9\u05D8\u05D9\u05DD", verb: "\u05DC\u05DB\u05DC\u05D5\u05DC" }, set: { unit: "\u05E4\u05E8\u05D9\u05D8\u05D9\u05DD", verb: "\u05DC\u05DB\u05DC\u05D5\u05DC" } };
  function t(n) {
    return e[n] ?? null;
  }
  let r = (n) => {
    let i = typeof n;
    switch (i) {
      case "number":
        return Number.isNaN(n) ? "NaN" : "number";
      case "object": {
        if (Array.isArray(n)) return "array";
        if (n === null) return "null";
        if (Object.getPrototypeOf(n) !== Object.prototype && n.constructor) return n.constructor.name;
      }
    }
    return i;
  }, o = { regex: "\u05E7\u05DC\u05D8", email: "\u05DB\u05EA\u05D5\u05D1\u05EA \u05D0\u05D9\u05DE\u05D9\u05D9\u05DC", url: "\u05DB\u05EA\u05D5\u05D1\u05EA \u05E8\u05E9\u05EA", emoji: "\u05D0\u05D9\u05DE\u05D5\u05D2'\u05D9", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "\u05EA\u05D0\u05E8\u05D9\u05DA \u05D5\u05D6\u05DE\u05DF ISO", date: "\u05EA\u05D0\u05E8\u05D9\u05DA ISO", time: "\u05D6\u05DE\u05DF ISO", duration: "\u05DE\u05E9\u05DA \u05D6\u05DE\u05DF ISO", ipv4: "\u05DB\u05EA\u05D5\u05D1\u05EA IPv4", ipv6: "\u05DB\u05EA\u05D5\u05D1\u05EA IPv6", cidrv4: "\u05D8\u05D5\u05D5\u05D7 IPv4", cidrv6: "\u05D8\u05D5\u05D5\u05D7 IPv6", base64: "\u05DE\u05D7\u05E8\u05D5\u05D6\u05EA \u05D1\u05D1\u05E1\u05D9\u05E1 64", base64url: "\u05DE\u05D7\u05E8\u05D5\u05D6\u05EA \u05D1\u05D1\u05E1\u05D9\u05E1 64 \u05DC\u05DB\u05EA\u05D5\u05D1\u05D5\u05EA \u05E8\u05E9\u05EA", json_string: "\u05DE\u05D7\u05E8\u05D5\u05D6\u05EA JSON", e164: "\u05DE\u05E1\u05E4\u05E8 E.164", jwt: "JWT", template_literal: "\u05E7\u05DC\u05D8" };
  return (n) => {
    switch (n.code) {
      case "invalid_type":
        return `\u05E7\u05DC\u05D8 \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF: \u05E6\u05E8\u05D9\u05DA ${n.expected}, \u05D4\u05EA\u05E7\u05D1\u05DC ${r(n.input)}`;
      case "invalid_value":
        if (n.values.length === 1) return `\u05E7\u05DC\u05D8 \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF: \u05E6\u05E8\u05D9\u05DA ${D(n.values[0])}`;
        return `\u05E7\u05DC\u05D8 \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF: \u05E6\u05E8\u05D9\u05DA \u05D0\u05D7\u05EA \u05DE\u05D4\u05D0\u05E4\u05E9\u05E8\u05D5\u05D9\u05D5\u05EA  ${P(n.values, "|")}`;
      case "too_big": {
        let i = n.inclusive ? "<=" : "<", s = t(n.origin);
        if (s) return `\u05D2\u05D3\u05D5\u05DC \u05DE\u05D3\u05D9: ${n.origin ?? "value"} \u05E6\u05E8\u05D9\u05DA \u05DC\u05D4\u05D9\u05D5\u05EA ${i}${n.maximum.toString()} ${s.unit ?? "elements"}`;
        return `\u05D2\u05D3\u05D5\u05DC \u05DE\u05D3\u05D9: ${n.origin ?? "value"} \u05E6\u05E8\u05D9\u05DA \u05DC\u05D4\u05D9\u05D5\u05EA ${i}${n.maximum.toString()}`;
      }
      case "too_small": {
        let i = n.inclusive ? ">=" : ">", s = t(n.origin);
        if (s) return `\u05E7\u05D8\u05DF \u05DE\u05D3\u05D9: ${n.origin} \u05E6\u05E8\u05D9\u05DA \u05DC\u05D4\u05D9\u05D5\u05EA ${i}${n.minimum.toString()} ${s.unit}`;
        return `\u05E7\u05D8\u05DF \u05DE\u05D3\u05D9: ${n.origin} \u05E6\u05E8\u05D9\u05DA \u05DC\u05D4\u05D9\u05D5\u05EA ${i}${n.minimum.toString()}`;
      }
      case "invalid_format": {
        let i = n;
        if (i.format === "starts_with") return `\u05DE\u05D7\u05E8\u05D5\u05D6\u05EA \u05DC\u05D0 \u05EA\u05E7\u05D9\u05E0\u05D4: \u05D7\u05D9\u05D9\u05D1\u05EA \u05DC\u05D4\u05EA\u05D7\u05D9\u05DC \u05D1"${i.prefix}"`;
        if (i.format === "ends_with") return `\u05DE\u05D7\u05E8\u05D5\u05D6\u05EA \u05DC\u05D0 \u05EA\u05E7\u05D9\u05E0\u05D4: \u05D7\u05D9\u05D9\u05D1\u05EA \u05DC\u05D4\u05E1\u05EA\u05D9\u05D9\u05DD \u05D1 "${i.suffix}"`;
        if (i.format === "includes") return `\u05DE\u05D7\u05E8\u05D5\u05D6\u05EA \u05DC\u05D0 \u05EA\u05E7\u05D9\u05E0\u05D4: \u05D7\u05D9\u05D9\u05D1\u05EA \u05DC\u05DB\u05DC\u05D5\u05DC "${i.includes}"`;
        if (i.format === "regex") return `\u05DE\u05D7\u05E8\u05D5\u05D6\u05EA \u05DC\u05D0 \u05EA\u05E7\u05D9\u05E0\u05D4: \u05D7\u05D9\u05D9\u05D1\u05EA \u05DC\u05D4\u05EA\u05D0\u05D9\u05DD \u05DC\u05EA\u05D1\u05E0\u05D9\u05EA ${i.pattern}`;
        return `${o[i.format] ?? n.format} \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF`;
      }
      case "not_multiple_of":
        return `\u05DE\u05E1\u05E4\u05E8 \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF: \u05D7\u05D9\u05D9\u05D1 \u05DC\u05D4\u05D9\u05D5\u05EA \u05DE\u05DB\u05E4\u05DC\u05D4 \u05E9\u05DC ${n.divisor}`;
      case "unrecognized_keys":
        return `\u05DE\u05E4\u05EA\u05D7${n.keys.length > 1 ? "\u05D5\u05EA" : ""} \u05DC\u05D0 \u05DE\u05D6\u05D5\u05D4${n.keys.length > 1 ? "\u05D9\u05DD" : "\u05D4"}: ${P(n.keys, ", ")}`;
      case "invalid_key":
        return `\u05DE\u05E4\u05EA\u05D7 \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF \u05D1${n.origin}`;
      case "invalid_union":
        return "\u05E7\u05DC\u05D8 \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF";
      case "invalid_element":
        return `\u05E2\u05E8\u05DA \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF \u05D1${n.origin}`;
      default:
        return "\u05E7\u05DC\u05D8 \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF";
    }
  };
};
function E_() {
  return { localeError: XZ() };
}
var YZ = () => {
  let e = { string: { unit: "karakter", verb: "legyen" }, file: { unit: "byte", verb: "legyen" }, array: { unit: "elem", verb: "legyen" }, set: { unit: "elem", verb: "legyen" } };
  function t(n) {
    return e[n] ?? null;
  }
  let r = (n) => {
    let i = typeof n;
    switch (i) {
      case "number":
        return Number.isNaN(n) ? "NaN" : "sz\xE1m";
      case "object": {
        if (Array.isArray(n)) return "t\xF6mb";
        if (n === null) return "null";
        if (Object.getPrototypeOf(n) !== Object.prototype && n.constructor) return n.constructor.name;
      }
    }
    return i;
  }, o = { regex: "bemenet", email: "email c\xEDm", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO id\u0151b\xE9lyeg", date: "ISO d\xE1tum", time: "ISO id\u0151", duration: "ISO id\u0151intervallum", ipv4: "IPv4 c\xEDm", ipv6: "IPv6 c\xEDm", cidrv4: "IPv4 tartom\xE1ny", cidrv6: "IPv6 tartom\xE1ny", base64: "base64-k\xF3dolt string", base64url: "base64url-k\xF3dolt string", json_string: "JSON string", e164: "E.164 sz\xE1m", jwt: "JWT", template_literal: "bemenet" };
  return (n) => {
    switch (n.code) {
      case "invalid_type":
        return `\xC9rv\xE9nytelen bemenet: a v\xE1rt \xE9rt\xE9k ${n.expected}, a kapott \xE9rt\xE9k ${r(n.input)}`;
      case "invalid_value":
        if (n.values.length === 1) return `\xC9rv\xE9nytelen bemenet: a v\xE1rt \xE9rt\xE9k ${D(n.values[0])}`;
        return `\xC9rv\xE9nytelen opci\xF3: valamelyik \xE9rt\xE9k v\xE1rt ${P(n.values, "|")}`;
      case "too_big": {
        let i = n.inclusive ? "<=" : "<", s = t(n.origin);
        if (s) return `T\xFAl nagy: ${n.origin ?? "\xE9rt\xE9k"} m\xE9rete t\xFAl nagy ${i}${n.maximum.toString()} ${s.unit ?? "elem"}`;
        return `T\xFAl nagy: a bemeneti \xE9rt\xE9k ${n.origin ?? "\xE9rt\xE9k"} t\xFAl nagy: ${i}${n.maximum.toString()}`;
      }
      case "too_small": {
        let i = n.inclusive ? ">=" : ">", s = t(n.origin);
        if (s) return `T\xFAl kicsi: a bemeneti \xE9rt\xE9k ${n.origin} m\xE9rete t\xFAl kicsi ${i}${n.minimum.toString()} ${s.unit}`;
        return `T\xFAl kicsi: a bemeneti \xE9rt\xE9k ${n.origin} t\xFAl kicsi ${i}${n.minimum.toString()}`;
      }
      case "invalid_format": {
        let i = n;
        if (i.format === "starts_with") return `\xC9rv\xE9nytelen string: "${i.prefix}" \xE9rt\xE9kkel kell kezd\u0151dnie`;
        if (i.format === "ends_with") return `\xC9rv\xE9nytelen string: "${i.suffix}" \xE9rt\xE9kkel kell v\xE9gz\u0151dnie`;
        if (i.format === "includes") return `\xC9rv\xE9nytelen string: "${i.includes}" \xE9rt\xE9ket kell tartalmaznia`;
        if (i.format === "regex") return `\xC9rv\xE9nytelen string: ${i.pattern} mint\xE1nak kell megfelelnie`;
        return `\xC9rv\xE9nytelen ${o[i.format] ?? n.format}`;
      }
      case "not_multiple_of":
        return `\xC9rv\xE9nytelen sz\xE1m: ${n.divisor} t\xF6bbsz\xF6r\xF6s\xE9nek kell lennie`;
      case "unrecognized_keys":
        return `Ismeretlen kulcs${n.keys.length > 1 ? "s" : ""}: ${P(n.keys, ", ")}`;
      case "invalid_key":
        return `\xC9rv\xE9nytelen kulcs ${n.origin}`;
      case "invalid_union":
        return "\xC9rv\xE9nytelen bemenet";
      case "invalid_element":
        return `\xC9rv\xE9nytelen \xE9rt\xE9k: ${n.origin}`;
      default:
        return "\xC9rv\xE9nytelen bemenet";
    }
  };
};
function P_() {
  return { localeError: YZ() };
}
var QZ = () => {
  let e = { string: { unit: "karakter", verb: "memiliki" }, file: { unit: "byte", verb: "memiliki" }, array: { unit: "item", verb: "memiliki" }, set: { unit: "item", verb: "memiliki" } };
  function t(n) {
    return e[n] ?? null;
  }
  let r = (n) => {
    let i = typeof n;
    switch (i) {
      case "number":
        return Number.isNaN(n) ? "NaN" : "number";
      case "object": {
        if (Array.isArray(n)) return "array";
        if (n === null) return "null";
        if (Object.getPrototypeOf(n) !== Object.prototype && n.constructor) return n.constructor.name;
      }
    }
    return i;
  }, o = { regex: "input", email: "alamat email", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "tanggal dan waktu format ISO", date: "tanggal format ISO", time: "jam format ISO", duration: "durasi format ISO", ipv4: "alamat IPv4", ipv6: "alamat IPv6", cidrv4: "rentang alamat IPv4", cidrv6: "rentang alamat IPv6", base64: "string dengan enkode base64", base64url: "string dengan enkode base64url", json_string: "string JSON", e164: "angka E.164", jwt: "JWT", template_literal: "input" };
  return (n) => {
    switch (n.code) {
      case "invalid_type":
        return `Input tidak valid: diharapkan ${n.expected}, diterima ${r(n.input)}`;
      case "invalid_value":
        if (n.values.length === 1) return `Input tidak valid: diharapkan ${D(n.values[0])}`;
        return `Pilihan tidak valid: diharapkan salah satu dari ${P(n.values, "|")}`;
      case "too_big": {
        let i = n.inclusive ? "<=" : "<", s = t(n.origin);
        if (s) return `Terlalu besar: diharapkan ${n.origin ?? "value"} memiliki ${i}${n.maximum.toString()} ${s.unit ?? "elemen"}`;
        return `Terlalu besar: diharapkan ${n.origin ?? "value"} menjadi ${i}${n.maximum.toString()}`;
      }
      case "too_small": {
        let i = n.inclusive ? ">=" : ">", s = t(n.origin);
        if (s) return `Terlalu kecil: diharapkan ${n.origin} memiliki ${i}${n.minimum.toString()} ${s.unit}`;
        return `Terlalu kecil: diharapkan ${n.origin} menjadi ${i}${n.minimum.toString()}`;
      }
      case "invalid_format": {
        let i = n;
        if (i.format === "starts_with") return `String tidak valid: harus dimulai dengan "${i.prefix}"`;
        if (i.format === "ends_with") return `String tidak valid: harus berakhir dengan "${i.suffix}"`;
        if (i.format === "includes") return `String tidak valid: harus menyertakan "${i.includes}"`;
        if (i.format === "regex") return `String tidak valid: harus sesuai pola ${i.pattern}`;
        return `${o[i.format] ?? n.format} tidak valid`;
      }
      case "not_multiple_of":
        return `Angka tidak valid: harus kelipatan dari ${n.divisor}`;
      case "unrecognized_keys":
        return `Kunci tidak dikenali ${n.keys.length > 1 ? "s" : ""}: ${P(n.keys, ", ")}`;
      case "invalid_key":
        return `Kunci tidak valid di ${n.origin}`;
      case "invalid_union":
        return "Input tidak valid";
      case "invalid_element":
        return `Nilai tidak valid di ${n.origin}`;
      default:
        return "Input tidak valid";
    }
  };
};
function T_() {
  return { localeError: QZ() };
}
var eW = () => {
  let e = { string: { unit: "caratteri", verb: "avere" }, file: { unit: "byte", verb: "avere" }, array: { unit: "elementi", verb: "avere" }, set: { unit: "elementi", verb: "avere" } };
  function t(n) {
    return e[n] ?? null;
  }
  let r = (n) => {
    let i = typeof n;
    switch (i) {
      case "number":
        return Number.isNaN(n) ? "NaN" : "numero";
      case "object": {
        if (Array.isArray(n)) return "vettore";
        if (n === null) return "null";
        if (Object.getPrototypeOf(n) !== Object.prototype && n.constructor) return n.constructor.name;
      }
    }
    return i;
  }, o = { regex: "input", email: "indirizzo email", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "data e ora ISO", date: "data ISO", time: "ora ISO", duration: "durata ISO", ipv4: "indirizzo IPv4", ipv6: "indirizzo IPv6", cidrv4: "intervallo IPv4", cidrv6: "intervallo IPv6", base64: "stringa codificata in base64", base64url: "URL codificata in base64", json_string: "stringa JSON", e164: "numero E.164", jwt: "JWT", template_literal: "input" };
  return (n) => {
    switch (n.code) {
      case "invalid_type":
        return `Input non valido: atteso ${n.expected}, ricevuto ${r(n.input)}`;
      case "invalid_value":
        if (n.values.length === 1) return `Input non valido: atteso ${D(n.values[0])}`;
        return `Opzione non valida: atteso uno tra ${P(n.values, "|")}`;
      case "too_big": {
        let i = n.inclusive ? "<=" : "<", s = t(n.origin);
        if (s) return `Troppo grande: ${n.origin ?? "valore"} deve avere ${i}${n.maximum.toString()} ${s.unit ?? "elementi"}`;
        return `Troppo grande: ${n.origin ?? "valore"} deve essere ${i}${n.maximum.toString()}`;
      }
      case "too_small": {
        let i = n.inclusive ? ">=" : ">", s = t(n.origin);
        if (s) return `Troppo piccolo: ${n.origin} deve avere ${i}${n.minimum.toString()} ${s.unit}`;
        return `Troppo piccolo: ${n.origin} deve essere ${i}${n.minimum.toString()}`;
      }
      case "invalid_format": {
        let i = n;
        if (i.format === "starts_with") return `Stringa non valida: deve iniziare con "${i.prefix}"`;
        if (i.format === "ends_with") return `Stringa non valida: deve terminare con "${i.suffix}"`;
        if (i.format === "includes") return `Stringa non valida: deve includere "${i.includes}"`;
        if (i.format === "regex") return `Stringa non valida: deve corrispondere al pattern ${i.pattern}`;
        return `Invalid ${o[i.format] ?? n.format}`;
      }
      case "not_multiple_of":
        return `Numero non valido: deve essere un multiplo di ${n.divisor}`;
      case "unrecognized_keys":
        return `Chiav${n.keys.length > 1 ? "i" : "e"} non riconosciut${n.keys.length > 1 ? "e" : "a"}: ${P(n.keys, ", ")}`;
      case "invalid_key":
        return `Chiave non valida in ${n.origin}`;
      case "invalid_union":
        return "Input non valido";
      case "invalid_element":
        return `Valore non valido in ${n.origin}`;
      default:
        return "Input non valido";
    }
  };
};
function I_() {
  return { localeError: eW() };
}
var tW = () => {
  let e = { string: { unit: "\u6587\u5B57", verb: "\u3067\u3042\u308B" }, file: { unit: "\u30D0\u30A4\u30C8", verb: "\u3067\u3042\u308B" }, array: { unit: "\u8981\u7D20", verb: "\u3067\u3042\u308B" }, set: { unit: "\u8981\u7D20", verb: "\u3067\u3042\u308B" } };
  function t(n) {
    return e[n] ?? null;
  }
  let r = (n) => {
    let i = typeof n;
    switch (i) {
      case "number":
        return Number.isNaN(n) ? "NaN" : "\u6570\u5024";
      case "object": {
        if (Array.isArray(n)) return "\u914D\u5217";
        if (n === null) return "null";
        if (Object.getPrototypeOf(n) !== Object.prototype && n.constructor) return n.constructor.name;
      }
    }
    return i;
  }, o = { regex: "\u5165\u529B\u5024", email: "\u30E1\u30FC\u30EB\u30A2\u30C9\u30EC\u30B9", url: "URL", emoji: "\u7D75\u6587\u5B57", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO\u65E5\u6642", date: "ISO\u65E5\u4ED8", time: "ISO\u6642\u523B", duration: "ISO\u671F\u9593", ipv4: "IPv4\u30A2\u30C9\u30EC\u30B9", ipv6: "IPv6\u30A2\u30C9\u30EC\u30B9", cidrv4: "IPv4\u7BC4\u56F2", cidrv6: "IPv6\u7BC4\u56F2", base64: "base64\u30A8\u30F3\u30B3\u30FC\u30C9\u6587\u5B57\u5217", base64url: "base64url\u30A8\u30F3\u30B3\u30FC\u30C9\u6587\u5B57\u5217", json_string: "JSON\u6587\u5B57\u5217", e164: "E.164\u756A\u53F7", jwt: "JWT", template_literal: "\u5165\u529B\u5024" };
  return (n) => {
    switch (n.code) {
      case "invalid_type":
        return `\u7121\u52B9\u306A\u5165\u529B: ${n.expected}\u304C\u671F\u5F85\u3055\u308C\u307E\u3057\u305F\u304C\u3001${r(n.input)}\u304C\u5165\u529B\u3055\u308C\u307E\u3057\u305F`;
      case "invalid_value":
        if (n.values.length === 1) return `\u7121\u52B9\u306A\u5165\u529B: ${D(n.values[0])}\u304C\u671F\u5F85\u3055\u308C\u307E\u3057\u305F`;
        return `\u7121\u52B9\u306A\u9078\u629E: ${P(n.values, "\u3001")}\u306E\u3044\u305A\u308C\u304B\u3067\u3042\u308B\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
      case "too_big": {
        let i = n.inclusive ? "\u4EE5\u4E0B\u3067\u3042\u308B" : "\u3088\u308A\u5C0F\u3055\u3044", s = t(n.origin);
        if (s) return `\u5927\u304D\u3059\u304E\u308B\u5024: ${n.origin ?? "\u5024"}\u306F${n.maximum.toString()}${s.unit ?? "\u8981\u7D20"}${i}\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
        return `\u5927\u304D\u3059\u304E\u308B\u5024: ${n.origin ?? "\u5024"}\u306F${n.maximum.toString()}${i}\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
      }
      case "too_small": {
        let i = n.inclusive ? "\u4EE5\u4E0A\u3067\u3042\u308B" : "\u3088\u308A\u5927\u304D\u3044", s = t(n.origin);
        if (s) return `\u5C0F\u3055\u3059\u304E\u308B\u5024: ${n.origin}\u306F${n.minimum.toString()}${s.unit}${i}\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
        return `\u5C0F\u3055\u3059\u304E\u308B\u5024: ${n.origin}\u306F${n.minimum.toString()}${i}\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
      }
      case "invalid_format": {
        let i = n;
        if (i.format === "starts_with") return `\u7121\u52B9\u306A\u6587\u5B57\u5217: "${i.prefix}"\u3067\u59CB\u307E\u308B\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
        if (i.format === "ends_with") return `\u7121\u52B9\u306A\u6587\u5B57\u5217: "${i.suffix}"\u3067\u7D42\u308F\u308B\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
        if (i.format === "includes") return `\u7121\u52B9\u306A\u6587\u5B57\u5217: "${i.includes}"\u3092\u542B\u3080\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
        if (i.format === "regex") return `\u7121\u52B9\u306A\u6587\u5B57\u5217: \u30D1\u30BF\u30FC\u30F3${i.pattern}\u306B\u4E00\u81F4\u3059\u308B\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
        return `\u7121\u52B9\u306A${o[i.format] ?? n.format}`;
      }
      case "not_multiple_of":
        return `\u7121\u52B9\u306A\u6570\u5024: ${n.divisor}\u306E\u500D\u6570\u3067\u3042\u308B\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
      case "unrecognized_keys":
        return `\u8A8D\u8B58\u3055\u308C\u3066\u3044\u306A\u3044\u30AD\u30FC${n.keys.length > 1 ? "\u7FA4" : ""}: ${P(n.keys, "\u3001")}`;
      case "invalid_key":
        return `${n.origin}\u5185\u306E\u7121\u52B9\u306A\u30AD\u30FC`;
      case "invalid_union":
        return "\u7121\u52B9\u306A\u5165\u529B";
      case "invalid_element":
        return `${n.origin}\u5185\u306E\u7121\u52B9\u306A\u5024`;
      default:
        return "\u7121\u52B9\u306A\u5165\u529B";
    }
  };
};
function R_() {
  return { localeError: tW() };
}
var rW = () => {
  let e = { string: { unit: "\u178F\u17BD\u17A2\u1780\u17D2\u179F\u179A", verb: "\u1782\u17BD\u179A\u1798\u17B6\u1793" }, file: { unit: "\u1794\u17C3", verb: "\u1782\u17BD\u179A\u1798\u17B6\u1793" }, array: { unit: "\u1792\u17B6\u178F\u17BB", verb: "\u1782\u17BD\u179A\u1798\u17B6\u1793" }, set: { unit: "\u1792\u17B6\u178F\u17BB", verb: "\u1782\u17BD\u179A\u1798\u17B6\u1793" } };
  function t(n) {
    return e[n] ?? null;
  }
  let r = (n) => {
    let i = typeof n;
    switch (i) {
      case "number":
        return Number.isNaN(n) ? "\u1798\u17B7\u1793\u1798\u17C2\u1793\u1787\u17B6\u179B\u17C1\u1781 (NaN)" : "\u179B\u17C1\u1781";
      case "object": {
        if (Array.isArray(n)) return "\u17A2\u17B6\u179A\u17C1 (Array)";
        if (n === null) return "\u1782\u17D2\u1798\u17B6\u1793\u178F\u1798\u17D2\u179B\u17C3 (null)";
        if (Object.getPrototypeOf(n) !== Object.prototype && n.constructor) return n.constructor.name;
      }
    }
    return i;
  }, o = { regex: "\u1791\u17B7\u1793\u17D2\u1793\u1793\u17D0\u1799\u1794\u1789\u17D2\u1785\u17BC\u179B", email: "\u17A2\u17B6\u179F\u1799\u178A\u17D2\u178B\u17B6\u1793\u17A2\u17CA\u17B8\u1798\u17C2\u179B", url: "URL", emoji: "\u179F\u1789\u17D2\u1789\u17B6\u17A2\u17B6\u179A\u1798\u17D2\u1798\u178E\u17CD", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "\u1780\u17B6\u179B\u1794\u179A\u17B7\u1785\u17D2\u1786\u17C1\u1791 \u1793\u17B7\u1784\u1798\u17C9\u17C4\u1784 ISO", date: "\u1780\u17B6\u179B\u1794\u179A\u17B7\u1785\u17D2\u1786\u17C1\u1791 ISO", time: "\u1798\u17C9\u17C4\u1784 ISO", duration: "\u179A\u1799\u17C8\u1796\u17C1\u179B ISO", ipv4: "\u17A2\u17B6\u179F\u1799\u178A\u17D2\u178B\u17B6\u1793 IPv4", ipv6: "\u17A2\u17B6\u179F\u1799\u178A\u17D2\u178B\u17B6\u1793 IPv6", cidrv4: "\u178A\u17C2\u1793\u17A2\u17B6\u179F\u1799\u178A\u17D2\u178B\u17B6\u1793 IPv4", cidrv6: "\u178A\u17C2\u1793\u17A2\u17B6\u179F\u1799\u178A\u17D2\u178B\u17B6\u1793 IPv6", base64: "\u1781\u17D2\u179F\u17C2\u17A2\u1780\u17D2\u179F\u179A\u17A2\u17CA\u17B7\u1780\u17BC\u178A base64", base64url: "\u1781\u17D2\u179F\u17C2\u17A2\u1780\u17D2\u179F\u179A\u17A2\u17CA\u17B7\u1780\u17BC\u178A base64url", json_string: "\u1781\u17D2\u179F\u17C2\u17A2\u1780\u17D2\u179F\u179A JSON", e164: "\u179B\u17C1\u1781 E.164", jwt: "JWT", template_literal: "\u1791\u17B7\u1793\u17D2\u1793\u1793\u17D0\u1799\u1794\u1789\u17D2\u1785\u17BC\u179B" };
  return (n) => {
    switch (n.code) {
      case "invalid_type":
        return `\u1791\u17B7\u1793\u17D2\u1793\u1793\u17D0\u1799\u1794\u1789\u17D2\u1785\u17BC\u179B\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1780\u17B6\u179A ${n.expected} \u1794\u17C9\u17BB\u1793\u17D2\u178F\u17C2\u1791\u1791\u17BD\u179B\u1794\u17B6\u1793 ${r(n.input)}`;
      case "invalid_value":
        if (n.values.length === 1) return `\u1791\u17B7\u1793\u17D2\u1793\u1793\u17D0\u1799\u1794\u1789\u17D2\u1785\u17BC\u179B\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1780\u17B6\u179A ${D(n.values[0])}`;
        return `\u1787\u1798\u17D2\u179A\u17BE\u179F\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1787\u17B6\u1798\u17BD\u1799\u1780\u17D2\u1793\u17BB\u1784\u1785\u17C6\u178E\u17C4\u1798 ${P(n.values, "|")}`;
      case "too_big": {
        let i = n.inclusive ? "<=" : "<", s = t(n.origin);
        if (s) return `\u1792\u17C6\u1796\u17C1\u1780\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1780\u17B6\u179A ${n.origin ?? "\u178F\u1798\u17D2\u179B\u17C3"} ${i} ${n.maximum.toString()} ${s.unit ?? "\u1792\u17B6\u178F\u17BB"}`;
        return `\u1792\u17C6\u1796\u17C1\u1780\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1780\u17B6\u179A ${n.origin ?? "\u178F\u1798\u17D2\u179B\u17C3"} ${i} ${n.maximum.toString()}`;
      }
      case "too_small": {
        let i = n.inclusive ? ">=" : ">", s = t(n.origin);
        if (s) return `\u178F\u17BC\u1785\u1796\u17C1\u1780\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1780\u17B6\u179A ${n.origin} ${i} ${n.minimum.toString()} ${s.unit}`;
        return `\u178F\u17BC\u1785\u1796\u17C1\u1780\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1780\u17B6\u179A ${n.origin} ${i} ${n.minimum.toString()}`;
      }
      case "invalid_format": {
        let i = n;
        if (i.format === "starts_with") return `\u1781\u17D2\u179F\u17C2\u17A2\u1780\u17D2\u179F\u179A\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1785\u17B6\u1794\u17CB\u1795\u17D2\u178F\u17BE\u1798\u178A\u17C4\u1799 "${i.prefix}"`;
        if (i.format === "ends_with") return `\u1781\u17D2\u179F\u17C2\u17A2\u1780\u17D2\u179F\u179A\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1794\u1789\u17D2\u1785\u1794\u17CB\u178A\u17C4\u1799 "${i.suffix}"`;
        if (i.format === "includes") return `\u1781\u17D2\u179F\u17C2\u17A2\u1780\u17D2\u179F\u179A\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1798\u17B6\u1793 "${i.includes}"`;
        if (i.format === "regex") return `\u1781\u17D2\u179F\u17C2\u17A2\u1780\u17D2\u179F\u179A\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u178F\u17C2\u1795\u17D2\u1782\u17BC\u1795\u17D2\u1782\u1784\u1793\u17B9\u1784\u1791\u1798\u17D2\u179A\u1784\u17CB\u178A\u17C2\u179B\u1794\u17B6\u1793\u1780\u17C6\u178E\u178F\u17CB ${i.pattern}`;
        return `\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 ${o[i.format] ?? n.format}`;
      }
      case "not_multiple_of":
        return `\u179B\u17C1\u1781\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u178F\u17C2\u1787\u17B6\u1796\u17A0\u17BB\u1782\u17BB\u178E\u1793\u17C3 ${n.divisor}`;
      case "unrecognized_keys":
        return `\u179A\u1780\u1783\u17BE\u1789\u179F\u17C4\u1798\u17B7\u1793\u179F\u17D2\u1782\u17B6\u179B\u17CB\u17D6 ${P(n.keys, ", ")}`;
      case "invalid_key":
        return `\u179F\u17C4\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u1793\u17C5\u1780\u17D2\u1793\u17BB\u1784 ${n.origin}`;
      case "invalid_union":
        return "\u1791\u17B7\u1793\u17D2\u1793\u1793\u17D0\u1799\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C";
      case "invalid_element":
        return `\u1791\u17B7\u1793\u17D2\u1793\u1793\u17D0\u1799\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u1793\u17C5\u1780\u17D2\u1793\u17BB\u1784 ${n.origin}`;
      default:
        return "\u1791\u17B7\u1793\u17D2\u1793\u1793\u17D0\u1799\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C";
    }
  };
};
function $_() {
  return { localeError: rW() };
}
var nW = () => {
  let e = { string: { unit: "\uBB38\uC790", verb: "to have" }, file: { unit: "\uBC14\uC774\uD2B8", verb: "to have" }, array: { unit: "\uAC1C", verb: "to have" }, set: { unit: "\uAC1C", verb: "to have" } };
  function t(n) {
    return e[n] ?? null;
  }
  let r = (n) => {
    let i = typeof n;
    switch (i) {
      case "number":
        return Number.isNaN(n) ? "NaN" : "number";
      case "object": {
        if (Array.isArray(n)) return "array";
        if (n === null) return "null";
        if (Object.getPrototypeOf(n) !== Object.prototype && n.constructor) return n.constructor.name;
      }
    }
    return i;
  }, o = { regex: "\uC785\uB825", email: "\uC774\uBA54\uC77C \uC8FC\uC18C", url: "URL", emoji: "\uC774\uBAA8\uC9C0", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO \uB0A0\uC9DC\uC2DC\uAC04", date: "ISO \uB0A0\uC9DC", time: "ISO \uC2DC\uAC04", duration: "ISO \uAE30\uAC04", ipv4: "IPv4 \uC8FC\uC18C", ipv6: "IPv6 \uC8FC\uC18C", cidrv4: "IPv4 \uBC94\uC704", cidrv6: "IPv6 \uBC94\uC704", base64: "base64 \uC778\uCF54\uB529 \uBB38\uC790\uC5F4", base64url: "base64url \uC778\uCF54\uB529 \uBB38\uC790\uC5F4", json_string: "JSON \uBB38\uC790\uC5F4", e164: "E.164 \uBC88\uD638", jwt: "JWT", template_literal: "\uC785\uB825" };
  return (n) => {
    switch (n.code) {
      case "invalid_type":
        return `\uC798\uBABB\uB41C \uC785\uB825: \uC608\uC0C1 \uD0C0\uC785\uC740 ${n.expected}, \uBC1B\uC740 \uD0C0\uC785\uC740 ${r(n.input)}\uC785\uB2C8\uB2E4`;
      case "invalid_value":
        if (n.values.length === 1) return `\uC798\uBABB\uB41C \uC785\uB825: \uAC12\uC740 ${D(n.values[0])} \uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4`;
        return `\uC798\uBABB\uB41C \uC635\uC158: ${P(n.values, "\uB610\uB294 ")} \uC911 \uD558\uB098\uC5EC\uC57C \uD569\uB2C8\uB2E4`;
      case "too_big": {
        let i = n.inclusive ? "\uC774\uD558" : "\uBBF8\uB9CC", s = i === "\uBBF8\uB9CC" ? "\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4" : "\uC5EC\uC57C \uD569\uB2C8\uB2E4", a = t(n.origin), c = a?.unit ?? "\uC694\uC18C";
        if (a) return `${n.origin ?? "\uAC12"}\uC774 \uB108\uBB34 \uD07D\uB2C8\uB2E4: ${n.maximum.toString()}${c} ${i}${s}`;
        return `${n.origin ?? "\uAC12"}\uC774 \uB108\uBB34 \uD07D\uB2C8\uB2E4: ${n.maximum.toString()} ${i}${s}`;
      }
      case "too_small": {
        let i = n.inclusive ? "\uC774\uC0C1" : "\uCD08\uACFC", s = i === "\uC774\uC0C1" ? "\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4" : "\uC5EC\uC57C \uD569\uB2C8\uB2E4", a = t(n.origin), c = a?.unit ?? "\uC694\uC18C";
        if (a) return `${n.origin ?? "\uAC12"}\uC774 \uB108\uBB34 \uC791\uC2B5\uB2C8\uB2E4: ${n.minimum.toString()}${c} ${i}${s}`;
        return `${n.origin ?? "\uAC12"}\uC774 \uB108\uBB34 \uC791\uC2B5\uB2C8\uB2E4: ${n.minimum.toString()} ${i}${s}`;
      }
      case "invalid_format": {
        let i = n;
        if (i.format === "starts_with") return `\uC798\uBABB\uB41C \uBB38\uC790\uC5F4: "${i.prefix}"(\uC73C)\uB85C \uC2DC\uC791\uD574\uC57C \uD569\uB2C8\uB2E4`;
        if (i.format === "ends_with") return `\uC798\uBABB\uB41C \uBB38\uC790\uC5F4: "${i.suffix}"(\uC73C)\uB85C \uB05D\uB098\uC57C \uD569\uB2C8\uB2E4`;
        if (i.format === "includes") return `\uC798\uBABB\uB41C \uBB38\uC790\uC5F4: "${i.includes}"\uC744(\uB97C) \uD3EC\uD568\uD574\uC57C \uD569\uB2C8\uB2E4`;
        if (i.format === "regex") return `\uC798\uBABB\uB41C \uBB38\uC790\uC5F4: \uC815\uADDC\uC2DD ${i.pattern} \uD328\uD134\uACFC \uC77C\uCE58\uD574\uC57C \uD569\uB2C8\uB2E4`;
        return `\uC798\uBABB\uB41C ${o[i.format] ?? n.format}`;
      }
      case "not_multiple_of":
        return `\uC798\uBABB\uB41C \uC22B\uC790: ${n.divisor}\uC758 \uBC30\uC218\uC5EC\uC57C \uD569\uB2C8\uB2E4`;
      case "unrecognized_keys":
        return `\uC778\uC2DD\uD560 \uC218 \uC5C6\uB294 \uD0A4: ${P(n.keys, ", ")}`;
      case "invalid_key":
        return `\uC798\uBABB\uB41C \uD0A4: ${n.origin}`;
      case "invalid_union":
        return "\uC798\uBABB\uB41C \uC785\uB825";
      case "invalid_element":
        return `\uC798\uBABB\uB41C \uAC12: ${n.origin}`;
      default:
        return "\uC798\uBABB\uB41C \uC785\uB825";
    }
  };
};
function A_() {
  return { localeError: nW() };
}
var oW = () => {
  let e = { string: { unit: "\u0437\u043D\u0430\u0446\u0438", verb: "\u0434\u0430 \u0438\u043C\u0430\u0430\u0442" }, file: { unit: "\u0431\u0430\u0458\u0442\u0438", verb: "\u0434\u0430 \u0438\u043C\u0430\u0430\u0442" }, array: { unit: "\u0441\u0442\u0430\u0432\u043A\u0438", verb: "\u0434\u0430 \u0438\u043C\u0430\u0430\u0442" }, set: { unit: "\u0441\u0442\u0430\u0432\u043A\u0438", verb: "\u0434\u0430 \u0438\u043C\u0430\u0430\u0442" } };
  function t(n) {
    return e[n] ?? null;
  }
  let r = (n) => {
    let i = typeof n;
    switch (i) {
      case "number":
        return Number.isNaN(n) ? "NaN" : "\u0431\u0440\u043E\u0458";
      case "object": {
        if (Array.isArray(n)) return "\u043D\u0438\u0437\u0430";
        if (n === null) return "null";
        if (Object.getPrototypeOf(n) !== Object.prototype && n.constructor) return n.constructor.name;
      }
    }
    return i;
  }, o = { regex: "\u0432\u043D\u0435\u0441", email: "\u0430\u0434\u0440\u0435\u0441\u0430 \u043D\u0430 \u0435-\u043F\u043E\u0448\u0442\u0430", url: "URL", emoji: "\u0435\u043C\u043E\u045F\u0438", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO \u0434\u0430\u0442\u0443\u043C \u0438 \u0432\u0440\u0435\u043C\u0435", date: "ISO \u0434\u0430\u0442\u0443\u043C", time: "ISO \u0432\u0440\u0435\u043C\u0435", duration: "ISO \u0432\u0440\u0435\u043C\u0435\u0442\u0440\u0430\u0435\u045A\u0435", ipv4: "IPv4 \u0430\u0434\u0440\u0435\u0441\u0430", ipv6: "IPv6 \u0430\u0434\u0440\u0435\u0441\u0430", cidrv4: "IPv4 \u043E\u043F\u0441\u0435\u0433", cidrv6: "IPv6 \u043E\u043F\u0441\u0435\u0433", base64: "base64-\u0435\u043D\u043A\u043E\u0434\u0438\u0440\u0430\u043D\u0430 \u043D\u0438\u0437\u0430", base64url: "base64url-\u0435\u043D\u043A\u043E\u0434\u0438\u0440\u0430\u043D\u0430 \u043D\u0438\u0437\u0430", json_string: "JSON \u043D\u0438\u0437\u0430", e164: "E.164 \u0431\u0440\u043E\u0458", jwt: "JWT", template_literal: "\u0432\u043D\u0435\u0441" };
  return (n) => {
    switch (n.code) {
      case "invalid_type":
        return `\u0413\u0440\u0435\u0448\u0435\u043D \u0432\u043D\u0435\u0441: \u0441\u0435 \u043E\u0447\u0435\u043A\u0443\u0432\u0430 ${n.expected}, \u043F\u0440\u0438\u043C\u0435\u043D\u043E ${r(n.input)}`;
      case "invalid_value":
        if (n.values.length === 1) return `Invalid input: expected ${D(n.values[0])}`;
        return `\u0413\u0440\u0435\u0448\u0430\u043D\u0430 \u043E\u043F\u0446\u0438\u0458\u0430: \u0441\u0435 \u043E\u0447\u0435\u043A\u0443\u0432\u0430 \u0435\u0434\u043D\u0430 ${P(n.values, "|")}`;
      case "too_big": {
        let i = n.inclusive ? "<=" : "<", s = t(n.origin);
        if (s) return `\u041F\u0440\u0435\u043C\u043D\u043E\u0433\u0443 \u0433\u043E\u043B\u0435\u043C: \u0441\u0435 \u043E\u0447\u0435\u043A\u0443\u0432\u0430 ${n.origin ?? "\u0432\u0440\u0435\u0434\u043D\u043E\u0441\u0442\u0430"} \u0434\u0430 \u0438\u043C\u0430 ${i}${n.maximum.toString()} ${s.unit ?? "\u0435\u043B\u0435\u043C\u0435\u043D\u0442\u0438"}`;
        return `\u041F\u0440\u0435\u043C\u043D\u043E\u0433\u0443 \u0433\u043E\u043B\u0435\u043C: \u0441\u0435 \u043E\u0447\u0435\u043A\u0443\u0432\u0430 ${n.origin ?? "\u0432\u0440\u0435\u0434\u043D\u043E\u0441\u0442\u0430"} \u0434\u0430 \u0431\u0438\u0434\u0435 ${i}${n.maximum.toString()}`;
      }
      case "too_small": {
        let i = n.inclusive ? ">=" : ">", s = t(n.origin);
        if (s) return `\u041F\u0440\u0435\u043C\u043D\u043E\u0433\u0443 \u043C\u0430\u043B: \u0441\u0435 \u043E\u0447\u0435\u043A\u0443\u0432\u0430 ${n.origin} \u0434\u0430 \u0438\u043C\u0430 ${i}${n.minimum.toString()} ${s.unit}`;
        return `\u041F\u0440\u0435\u043C\u043D\u043E\u0433\u0443 \u043C\u0430\u043B: \u0441\u0435 \u043E\u0447\u0435\u043A\u0443\u0432\u0430 ${n.origin} \u0434\u0430 \u0431\u0438\u0434\u0435 ${i}${n.minimum.toString()}`;
      }
      case "invalid_format": {
        let i = n;
        if (i.format === "starts_with") return `\u041D\u0435\u0432\u0430\u0436\u0435\u0447\u043A\u0430 \u043D\u0438\u0437\u0430: \u043C\u043E\u0440\u0430 \u0434\u0430 \u0437\u0430\u043F\u043E\u0447\u043D\u0443\u0432\u0430 \u0441\u043E "${i.prefix}"`;
        if (i.format === "ends_with") return `\u041D\u0435\u0432\u0430\u0436\u0435\u0447\u043A\u0430 \u043D\u0438\u0437\u0430: \u043C\u043E\u0440\u0430 \u0434\u0430 \u0437\u0430\u0432\u0440\u0448\u0443\u0432\u0430 \u0441\u043E "${i.suffix}"`;
        if (i.format === "includes") return `\u041D\u0435\u0432\u0430\u0436\u0435\u0447\u043A\u0430 \u043D\u0438\u0437\u0430: \u043C\u043E\u0440\u0430 \u0434\u0430 \u0432\u043A\u043B\u0443\u0447\u0443\u0432\u0430 "${i.includes}"`;
        if (i.format === "regex") return `\u041D\u0435\u0432\u0430\u0436\u0435\u0447\u043A\u0430 \u043D\u0438\u0437\u0430: \u043C\u043E\u0440\u0430 \u0434\u0430 \u043E\u0434\u0433\u043E\u0430\u0440\u0430 \u043D\u0430 \u043F\u0430\u0442\u0435\u0440\u043D\u043E\u0442 ${i.pattern}`;
        return `Invalid ${o[i.format] ?? n.format}`;
      }
      case "not_multiple_of":
        return `\u0413\u0440\u0435\u0448\u0435\u043D \u0431\u0440\u043E\u0458: \u043C\u043E\u0440\u0430 \u0434\u0430 \u0431\u0438\u0434\u0435 \u0434\u0435\u043B\u0438\u0432 \u0441\u043E ${n.divisor}`;
      case "unrecognized_keys":
        return `${n.keys.length > 1 ? "\u041D\u0435\u043F\u0440\u0435\u043F\u043E\u0437\u043D\u0430\u0435\u043D\u0438 \u043A\u043B\u0443\u0447\u0435\u0432\u0438" : "\u041D\u0435\u043F\u0440\u0435\u043F\u043E\u0437\u043D\u0430\u0435\u043D \u043A\u043B\u0443\u0447"}: ${P(n.keys, ", ")}`;
      case "invalid_key":
        return `\u0413\u0440\u0435\u0448\u0435\u043D \u043A\u043B\u0443\u0447 \u0432\u043E ${n.origin}`;
      case "invalid_union":
        return "\u0413\u0440\u0435\u0448\u0435\u043D \u0432\u043D\u0435\u0441";
      case "invalid_element":
        return `\u0413\u0440\u0435\u0448\u043D\u0430 \u0432\u0440\u0435\u0434\u043D\u043E\u0441\u0442 \u0432\u043E ${n.origin}`;
      default:
        return "\u0413\u0440\u0435\u0448\u0435\u043D \u0432\u043D\u0435\u0441";
    }
  };
};
function O_() {
  return { localeError: oW() };
}
var iW = () => {
  let e = { string: { unit: "aksara", verb: "mempunyai" }, file: { unit: "bait", verb: "mempunyai" }, array: { unit: "elemen", verb: "mempunyai" }, set: { unit: "elemen", verb: "mempunyai" } };
  function t(n) {
    return e[n] ?? null;
  }
  let r = (n) => {
    let i = typeof n;
    switch (i) {
      case "number":
        return Number.isNaN(n) ? "NaN" : "nombor";
      case "object": {
        if (Array.isArray(n)) return "array";
        if (n === null) return "null";
        if (Object.getPrototypeOf(n) !== Object.prototype && n.constructor) return n.constructor.name;
      }
    }
    return i;
  }, o = { regex: "input", email: "alamat e-mel", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "tarikh masa ISO", date: "tarikh ISO", time: "masa ISO", duration: "tempoh ISO", ipv4: "alamat IPv4", ipv6: "alamat IPv6", cidrv4: "julat IPv4", cidrv6: "julat IPv6", base64: "string dikodkan base64", base64url: "string dikodkan base64url", json_string: "string JSON", e164: "nombor E.164", jwt: "JWT", template_literal: "input" };
  return (n) => {
    switch (n.code) {
      case "invalid_type":
        return `Input tidak sah: dijangka ${n.expected}, diterima ${r(n.input)}`;
      case "invalid_value":
        if (n.values.length === 1) return `Input tidak sah: dijangka ${D(n.values[0])}`;
        return `Pilihan tidak sah: dijangka salah satu daripada ${P(n.values, "|")}`;
      case "too_big": {
        let i = n.inclusive ? "<=" : "<", s = t(n.origin);
        if (s) return `Terlalu besar: dijangka ${n.origin ?? "nilai"} ${s.verb} ${i}${n.maximum.toString()} ${s.unit ?? "elemen"}`;
        return `Terlalu besar: dijangka ${n.origin ?? "nilai"} adalah ${i}${n.maximum.toString()}`;
      }
      case "too_small": {
        let i = n.inclusive ? ">=" : ">", s = t(n.origin);
        if (s) return `Terlalu kecil: dijangka ${n.origin} ${s.verb} ${i}${n.minimum.toString()} ${s.unit}`;
        return `Terlalu kecil: dijangka ${n.origin} adalah ${i}${n.minimum.toString()}`;
      }
      case "invalid_format": {
        let i = n;
        if (i.format === "starts_with") return `String tidak sah: mesti bermula dengan "${i.prefix}"`;
        if (i.format === "ends_with") return `String tidak sah: mesti berakhir dengan "${i.suffix}"`;
        if (i.format === "includes") return `String tidak sah: mesti mengandungi "${i.includes}"`;
        if (i.format === "regex") return `String tidak sah: mesti sepadan dengan corak ${i.pattern}`;
        return `${o[i.format] ?? n.format} tidak sah`;
      }
      case "not_multiple_of":
        return `Nombor tidak sah: perlu gandaan ${n.divisor}`;
      case "unrecognized_keys":
        return `Kunci tidak dikenali: ${P(n.keys, ", ")}`;
      case "invalid_key":
        return `Kunci tidak sah dalam ${n.origin}`;
      case "invalid_union":
        return "Input tidak sah";
      case "invalid_element":
        return `Nilai tidak sah dalam ${n.origin}`;
      default:
        return "Input tidak sah";
    }
  };
};
function C_() {
  return { localeError: iW() };
}
var sW = () => {
  let e = { string: { unit: "tekens" }, file: { unit: "bytes" }, array: { unit: "elementen" }, set: { unit: "elementen" } };
  function t(n) {
    return e[n] ?? null;
  }
  let r = (n) => {
    let i = typeof n;
    switch (i) {
      case "number":
        return Number.isNaN(n) ? "NaN" : "getal";
      case "object": {
        if (Array.isArray(n)) return "array";
        if (n === null) return "null";
        if (Object.getPrototypeOf(n) !== Object.prototype && n.constructor) return n.constructor.name;
      }
    }
    return i;
  }, o = { regex: "invoer", email: "emailadres", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO datum en tijd", date: "ISO datum", time: "ISO tijd", duration: "ISO duur", ipv4: "IPv4-adres", ipv6: "IPv6-adres", cidrv4: "IPv4-bereik", cidrv6: "IPv6-bereik", base64: "base64-gecodeerde tekst", base64url: "base64 URL-gecodeerde tekst", json_string: "JSON string", e164: "E.164-nummer", jwt: "JWT", template_literal: "invoer" };
  return (n) => {
    switch (n.code) {
      case "invalid_type":
        return `Ongeldige invoer: verwacht ${n.expected}, ontving ${r(n.input)}`;
      case "invalid_value":
        if (n.values.length === 1) return `Ongeldige invoer: verwacht ${D(n.values[0])}`;
        return `Ongeldige optie: verwacht \xE9\xE9n van ${P(n.values, "|")}`;
      case "too_big": {
        let i = n.inclusive ? "<=" : "<", s = t(n.origin);
        if (s) return `Te lang: verwacht dat ${n.origin ?? "waarde"} ${i}${n.maximum.toString()} ${s.unit ?? "elementen"} bevat`;
        return `Te lang: verwacht dat ${n.origin ?? "waarde"} ${i}${n.maximum.toString()} is`;
      }
      case "too_small": {
        let i = n.inclusive ? ">=" : ">", s = t(n.origin);
        if (s) return `Te kort: verwacht dat ${n.origin} ${i}${n.minimum.toString()} ${s.unit} bevat`;
        return `Te kort: verwacht dat ${n.origin} ${i}${n.minimum.toString()} is`;
      }
      case "invalid_format": {
        let i = n;
        if (i.format === "starts_with") return `Ongeldige tekst: moet met "${i.prefix}" beginnen`;
        if (i.format === "ends_with") return `Ongeldige tekst: moet op "${i.suffix}" eindigen`;
        if (i.format === "includes") return `Ongeldige tekst: moet "${i.includes}" bevatten`;
        if (i.format === "regex") return `Ongeldige tekst: moet overeenkomen met patroon ${i.pattern}`;
        return `Ongeldig: ${o[i.format] ?? n.format}`;
      }
      case "not_multiple_of":
        return `Ongeldig getal: moet een veelvoud van ${n.divisor} zijn`;
      case "unrecognized_keys":
        return `Onbekende key${n.keys.length > 1 ? "s" : ""}: ${P(n.keys, ", ")}`;
      case "invalid_key":
        return `Ongeldige key in ${n.origin}`;
      case "invalid_union":
        return "Ongeldige invoer";
      case "invalid_element":
        return `Ongeldige waarde in ${n.origin}`;
      default:
        return "Ongeldige invoer";
    }
  };
};
function M_() {
  return { localeError: sW() };
}
var aW = () => {
  let e = { string: { unit: "tegn", verb: "\xE5 ha" }, file: { unit: "bytes", verb: "\xE5 ha" }, array: { unit: "elementer", verb: "\xE5 inneholde" }, set: { unit: "elementer", verb: "\xE5 inneholde" } };
  function t(n) {
    return e[n] ?? null;
  }
  let r = (n) => {
    let i = typeof n;
    switch (i) {
      case "number":
        return Number.isNaN(n) ? "NaN" : "tall";
      case "object": {
        if (Array.isArray(n)) return "liste";
        if (n === null) return "null";
        if (Object.getPrototypeOf(n) !== Object.prototype && n.constructor) return n.constructor.name;
      }
    }
    return i;
  }, o = { regex: "input", email: "e-postadresse", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO dato- og klokkeslett", date: "ISO-dato", time: "ISO-klokkeslett", duration: "ISO-varighet", ipv4: "IPv4-omr\xE5de", ipv6: "IPv6-omr\xE5de", cidrv4: "IPv4-spekter", cidrv6: "IPv6-spekter", base64: "base64-enkodet streng", base64url: "base64url-enkodet streng", json_string: "JSON-streng", e164: "E.164-nummer", jwt: "JWT", template_literal: "input" };
  return (n) => {
    switch (n.code) {
      case "invalid_type":
        return `Ugyldig input: forventet ${n.expected}, fikk ${r(n.input)}`;
      case "invalid_value":
        if (n.values.length === 1) return `Ugyldig verdi: forventet ${D(n.values[0])}`;
        return `Ugyldig valg: forventet en av ${P(n.values, "|")}`;
      case "too_big": {
        let i = n.inclusive ? "<=" : "<", s = t(n.origin);
        if (s) return `For stor(t): forventet ${n.origin ?? "value"} til \xE5 ha ${i}${n.maximum.toString()} ${s.unit ?? "elementer"}`;
        return `For stor(t): forventet ${n.origin ?? "value"} til \xE5 ha ${i}${n.maximum.toString()}`;
      }
      case "too_small": {
        let i = n.inclusive ? ">=" : ">", s = t(n.origin);
        if (s) return `For lite(n): forventet ${n.origin} til \xE5 ha ${i}${n.minimum.toString()} ${s.unit}`;
        return `For lite(n): forventet ${n.origin} til \xE5 ha ${i}${n.minimum.toString()}`;
      }
      case "invalid_format": {
        let i = n;
        if (i.format === "starts_with") return `Ugyldig streng: m\xE5 starte med "${i.prefix}"`;
        if (i.format === "ends_with") return `Ugyldig streng: m\xE5 ende med "${i.suffix}"`;
        if (i.format === "includes") return `Ugyldig streng: m\xE5 inneholde "${i.includes}"`;
        if (i.format === "regex") return `Ugyldig streng: m\xE5 matche m\xF8nsteret ${i.pattern}`;
        return `Ugyldig ${o[i.format] ?? n.format}`;
      }
      case "not_multiple_of":
        return `Ugyldig tall: m\xE5 v\xE6re et multiplum av ${n.divisor}`;
      case "unrecognized_keys":
        return `${n.keys.length > 1 ? "Ukjente n\xF8kler" : "Ukjent n\xF8kkel"}: ${P(n.keys, ", ")}`;
      case "invalid_key":
        return `Ugyldig n\xF8kkel i ${n.origin}`;
      case "invalid_union":
        return "Ugyldig input";
      case "invalid_element":
        return `Ugyldig verdi i ${n.origin}`;
      default:
        return "Ugyldig input";
    }
  };
};
function D_() {
  return { localeError: aW() };
}
var cW = () => {
  let e = { string: { unit: "harf", verb: "olmal\u0131d\u0131r" }, file: { unit: "bayt", verb: "olmal\u0131d\u0131r" }, array: { unit: "unsur", verb: "olmal\u0131d\u0131r" }, set: { unit: "unsur", verb: "olmal\u0131d\u0131r" } };
  function t(n) {
    return e[n] ?? null;
  }
  let r = (n) => {
    let i = typeof n;
    switch (i) {
      case "number":
        return Number.isNaN(n) ? "NaN" : "numara";
      case "object": {
        if (Array.isArray(n)) return "saf";
        if (n === null) return "gayb";
        if (Object.getPrototypeOf(n) !== Object.prototype && n.constructor) return n.constructor.name;
      }
    }
    return i;
  }, o = { regex: "giren", email: "epostag\xE2h", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO heng\xE2m\u0131", date: "ISO tarihi", time: "ISO zaman\u0131", duration: "ISO m\xFCddeti", ipv4: "IPv4 ni\u015F\xE2n\u0131", ipv6: "IPv6 ni\u015F\xE2n\u0131", cidrv4: "IPv4 menzili", cidrv6: "IPv6 menzili", base64: "base64-\u015Fifreli metin", base64url: "base64url-\u015Fifreli metin", json_string: "JSON metin", e164: "E.164 say\u0131s\u0131", jwt: "JWT", template_literal: "giren" };
  return (n) => {
    switch (n.code) {
      case "invalid_type":
        return `F\xE2sit giren: umulan ${n.expected}, al\u0131nan ${r(n.input)}`;
      case "invalid_value":
        if (n.values.length === 1) return `F\xE2sit giren: umulan ${D(n.values[0])}`;
        return `F\xE2sit tercih: m\xFBteberler ${P(n.values, "|")}`;
      case "too_big": {
        let i = n.inclusive ? "<=" : "<", s = t(n.origin);
        if (s) return `Fazla b\xFCy\xFCk: ${n.origin ?? "value"}, ${i}${n.maximum.toString()} ${s.unit ?? "elements"} sahip olmal\u0131yd\u0131.`;
        return `Fazla b\xFCy\xFCk: ${n.origin ?? "value"}, ${i}${n.maximum.toString()} olmal\u0131yd\u0131.`;
      }
      case "too_small": {
        let i = n.inclusive ? ">=" : ">", s = t(n.origin);
        if (s) return `Fazla k\xFC\xE7\xFCk: ${n.origin}, ${i}${n.minimum.toString()} ${s.unit} sahip olmal\u0131yd\u0131.`;
        return `Fazla k\xFC\xE7\xFCk: ${n.origin}, ${i}${n.minimum.toString()} olmal\u0131yd\u0131.`;
      }
      case "invalid_format": {
        let i = n;
        if (i.format === "starts_with") return `F\xE2sit metin: "${i.prefix}" ile ba\u015Flamal\u0131.`;
        if (i.format === "ends_with") return `F\xE2sit metin: "${i.suffix}" ile bitmeli.`;
        if (i.format === "includes") return `F\xE2sit metin: "${i.includes}" ihtiv\xE2 etmeli.`;
        if (i.format === "regex") return `F\xE2sit metin: ${i.pattern} nak\u015F\u0131na uymal\u0131.`;
        return `F\xE2sit ${o[i.format] ?? n.format}`;
      }
      case "not_multiple_of":
        return `F\xE2sit say\u0131: ${n.divisor} kat\u0131 olmal\u0131yd\u0131.`;
      case "unrecognized_keys":
        return `Tan\u0131nmayan anahtar ${n.keys.length > 1 ? "s" : ""}: ${P(n.keys, ", ")}`;
      case "invalid_key":
        return `${n.origin} i\xE7in tan\u0131nmayan anahtar var.`;
      case "invalid_union":
        return "Giren tan\u0131namad\u0131.";
      case "invalid_element":
        return `${n.origin} i\xE7in tan\u0131nmayan k\u0131ymet var.`;
      default:
        return "K\u0131ymet tan\u0131namad\u0131.";
    }
  };
};
function N_() {
  return { localeError: cW() };
}
var lW = () => {
  let e = { string: { unit: "\u062A\u0648\u06A9\u064A", verb: "\u0648\u0644\u0631\u064A" }, file: { unit: "\u0628\u0627\u06CC\u067C\u0633", verb: "\u0648\u0644\u0631\u064A" }, array: { unit: "\u062A\u0648\u06A9\u064A", verb: "\u0648\u0644\u0631\u064A" }, set: { unit: "\u062A\u0648\u06A9\u064A", verb: "\u0648\u0644\u0631\u064A" } };
  function t(n) {
    return e[n] ?? null;
  }
  let r = (n) => {
    let i = typeof n;
    switch (i) {
      case "number":
        return Number.isNaN(n) ? "NaN" : "\u0639\u062F\u062F";
      case "object": {
        if (Array.isArray(n)) return "\u0627\u0631\u06D0";
        if (n === null) return "null";
        if (Object.getPrototypeOf(n) !== Object.prototype && n.constructor) return n.constructor.name;
      }
    }
    return i;
  }, o = { regex: "\u0648\u0631\u0648\u062F\u064A", email: "\u0628\u0631\u06CC\u069A\u0646\u0627\u0644\u06CC\u06A9", url: "\u06CC\u0648 \u0622\u0631 \u0627\u0644", emoji: "\u0627\u06CC\u0645\u0648\u062C\u064A", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "\u0646\u06CC\u067C\u0647 \u0627\u0648 \u0648\u062E\u062A", date: "\u0646\u06D0\u067C\u0647", time: "\u0648\u062E\u062A", duration: "\u0645\u0648\u062F\u0647", ipv4: "\u062F IPv4 \u067E\u062A\u0647", ipv6: "\u062F IPv6 \u067E\u062A\u0647", cidrv4: "\u062F IPv4 \u0633\u0627\u062D\u0647", cidrv6: "\u062F IPv6 \u0633\u0627\u062D\u0647", base64: "base64-encoded \u0645\u062A\u0646", base64url: "base64url-encoded \u0645\u062A\u0646", json_string: "JSON \u0645\u062A\u0646", e164: "\u062F E.164 \u0634\u0645\u06D0\u0631\u0647", jwt: "JWT", template_literal: "\u0648\u0631\u0648\u062F\u064A" };
  return (n) => {
    switch (n.code) {
      case "invalid_type":
        return `\u0646\u0627\u0633\u0645 \u0648\u0631\u0648\u062F\u064A: \u0628\u0627\u06CC\u062F ${n.expected} \u0648\u0627\u06CC, \u0645\u06AB\u0631 ${r(n.input)} \u062A\u0631\u0644\u0627\u0633\u0647 \u0634\u0648`;
      case "invalid_value":
        if (n.values.length === 1) return `\u0646\u0627\u0633\u0645 \u0648\u0631\u0648\u062F\u064A: \u0628\u0627\u06CC\u062F ${D(n.values[0])} \u0648\u0627\u06CC`;
        return `\u0646\u0627\u0633\u0645 \u0627\u0646\u062A\u062E\u0627\u0628: \u0628\u0627\u06CC\u062F \u06CC\u0648 \u0644\u0647 ${P(n.values, "|")} \u0685\u062E\u0647 \u0648\u0627\u06CC`;
      case "too_big": {
        let i = n.inclusive ? "<=" : "<", s = t(n.origin);
        if (s) return `\u0689\u06CC\u0631 \u0644\u0648\u06CC: ${n.origin ?? "\u0627\u0631\u0632\u069A\u062A"} \u0628\u0627\u06CC\u062F ${i}${n.maximum.toString()} ${s.unit ?? "\u0639\u0646\u0635\u0631\u0648\u0646\u0647"} \u0648\u0644\u0631\u064A`;
        return `\u0689\u06CC\u0631 \u0644\u0648\u06CC: ${n.origin ?? "\u0627\u0631\u0632\u069A\u062A"} \u0628\u0627\u06CC\u062F ${i}${n.maximum.toString()} \u0648\u064A`;
      }
      case "too_small": {
        let i = n.inclusive ? ">=" : ">", s = t(n.origin);
        if (s) return `\u0689\u06CC\u0631 \u06A9\u0648\u0686\u0646\u06CC: ${n.origin} \u0628\u0627\u06CC\u062F ${i}${n.minimum.toString()} ${s.unit} \u0648\u0644\u0631\u064A`;
        return `\u0689\u06CC\u0631 \u06A9\u0648\u0686\u0646\u06CC: ${n.origin} \u0628\u0627\u06CC\u062F ${i}${n.minimum.toString()} \u0648\u064A`;
      }
      case "invalid_format": {
        let i = n;
        if (i.format === "starts_with") return `\u0646\u0627\u0633\u0645 \u0645\u062A\u0646: \u0628\u0627\u06CC\u062F \u062F "${i.prefix}" \u0633\u0631\u0647 \u067E\u06CC\u0644 \u0634\u064A`;
        if (i.format === "ends_with") return `\u0646\u0627\u0633\u0645 \u0645\u062A\u0646: \u0628\u0627\u06CC\u062F \u062F "${i.suffix}" \u0633\u0631\u0647 \u067E\u0627\u06CC \u062A\u0647 \u0648\u0631\u0633\u064A\u0696\u064A`;
        if (i.format === "includes") return `\u0646\u0627\u0633\u0645 \u0645\u062A\u0646: \u0628\u0627\u06CC\u062F "${i.includes}" \u0648\u0644\u0631\u064A`;
        if (i.format === "regex") return `\u0646\u0627\u0633\u0645 \u0645\u062A\u0646: \u0628\u0627\u06CC\u062F \u062F ${i.pattern} \u0633\u0631\u0647 \u0645\u0637\u0627\u0628\u0642\u062A \u0648\u0644\u0631\u064A`;
        return `${o[i.format] ?? n.format} \u0646\u0627\u0633\u0645 \u062F\u06CC`;
      }
      case "not_multiple_of":
        return `\u0646\u0627\u0633\u0645 \u0639\u062F\u062F: \u0628\u0627\u06CC\u062F \u062F ${n.divisor} \u0645\u0636\u0631\u0628 \u0648\u064A`;
      case "unrecognized_keys":
        return `\u0646\u0627\u0633\u0645 ${n.keys.length > 1 ? "\u06A9\u0644\u06CC\u0689\u0648\u0646\u0647" : "\u06A9\u0644\u06CC\u0689"}: ${P(n.keys, ", ")}`;
      case "invalid_key":
        return `\u0646\u0627\u0633\u0645 \u06A9\u0644\u06CC\u0689 \u067E\u0647 ${n.origin} \u06A9\u06D0`;
      case "invalid_union":
        return "\u0646\u0627\u0633\u0645\u0647 \u0648\u0631\u0648\u062F\u064A";
      case "invalid_element":
        return `\u0646\u0627\u0633\u0645 \u0639\u0646\u0635\u0631 \u067E\u0647 ${n.origin} \u06A9\u06D0`;
      default:
        return "\u0646\u0627\u0633\u0645\u0647 \u0648\u0631\u0648\u062F\u064A";
    }
  };
};
function j_() {
  return { localeError: lW() };
}
var uW = () => {
  let e = { string: { unit: "znak\xF3w", verb: "mie\u0107" }, file: { unit: "bajt\xF3w", verb: "mie\u0107" }, array: { unit: "element\xF3w", verb: "mie\u0107" }, set: { unit: "element\xF3w", verb: "mie\u0107" } };
  function t(n) {
    return e[n] ?? null;
  }
  let r = (n) => {
    let i = typeof n;
    switch (i) {
      case "number":
        return Number.isNaN(n) ? "NaN" : "liczba";
      case "object": {
        if (Array.isArray(n)) return "tablica";
        if (n === null) return "null";
        if (Object.getPrototypeOf(n) !== Object.prototype && n.constructor) return n.constructor.name;
      }
    }
    return i;
  }, o = { regex: "wyra\u017Cenie", email: "adres email", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "data i godzina w formacie ISO", date: "data w formacie ISO", time: "godzina w formacie ISO", duration: "czas trwania ISO", ipv4: "adres IPv4", ipv6: "adres IPv6", cidrv4: "zakres IPv4", cidrv6: "zakres IPv6", base64: "ci\u0105g znak\xF3w zakodowany w formacie base64", base64url: "ci\u0105g znak\xF3w zakodowany w formacie base64url", json_string: "ci\u0105g znak\xF3w w formacie JSON", e164: "liczba E.164", jwt: "JWT", template_literal: "wej\u015Bcie" };
  return (n) => {
    switch (n.code) {
      case "invalid_type":
        return `Nieprawid\u0142owe dane wej\u015Bciowe: oczekiwano ${n.expected}, otrzymano ${r(n.input)}`;
      case "invalid_value":
        if (n.values.length === 1) return `Nieprawid\u0142owe dane wej\u015Bciowe: oczekiwano ${D(n.values[0])}`;
        return `Nieprawid\u0142owa opcja: oczekiwano jednej z warto\u015Bci ${P(n.values, "|")}`;
      case "too_big": {
        let i = n.inclusive ? "<=" : "<", s = t(n.origin);
        if (s) return `Za du\u017Ca warto\u015B\u0107: oczekiwano, \u017Ce ${n.origin ?? "warto\u015B\u0107"} b\u0119dzie mie\u0107 ${i}${n.maximum.toString()} ${s.unit ?? "element\xF3w"}`;
        return `Zbyt du\u017C(y/a/e): oczekiwano, \u017Ce ${n.origin ?? "warto\u015B\u0107"} b\u0119dzie wynosi\u0107 ${i}${n.maximum.toString()}`;
      }
      case "too_small": {
        let i = n.inclusive ? ">=" : ">", s = t(n.origin);
        if (s) return `Za ma\u0142a warto\u015B\u0107: oczekiwano, \u017Ce ${n.origin ?? "warto\u015B\u0107"} b\u0119dzie mie\u0107 ${i}${n.minimum.toString()} ${s.unit ?? "element\xF3w"}`;
        return `Zbyt ma\u0142(y/a/e): oczekiwano, \u017Ce ${n.origin ?? "warto\u015B\u0107"} b\u0119dzie wynosi\u0107 ${i}${n.minimum.toString()}`;
      }
      case "invalid_format": {
        let i = n;
        if (i.format === "starts_with") return `Nieprawid\u0142owy ci\u0105g znak\xF3w: musi zaczyna\u0107 si\u0119 od "${i.prefix}"`;
        if (i.format === "ends_with") return `Nieprawid\u0142owy ci\u0105g znak\xF3w: musi ko\u0144czy\u0107 si\u0119 na "${i.suffix}"`;
        if (i.format === "includes") return `Nieprawid\u0142owy ci\u0105g znak\xF3w: musi zawiera\u0107 "${i.includes}"`;
        if (i.format === "regex") return `Nieprawid\u0142owy ci\u0105g znak\xF3w: musi odpowiada\u0107 wzorcowi ${i.pattern}`;
        return `Nieprawid\u0142ow(y/a/e) ${o[i.format] ?? n.format}`;
      }
      case "not_multiple_of":
        return `Nieprawid\u0142owa liczba: musi by\u0107 wielokrotno\u015Bci\u0105 ${n.divisor}`;
      case "unrecognized_keys":
        return `Nierozpoznane klucze${n.keys.length > 1 ? "s" : ""}: ${P(n.keys, ", ")}`;
      case "invalid_key":
        return `Nieprawid\u0142owy klucz w ${n.origin}`;
      case "invalid_union":
        return "Nieprawid\u0142owe dane wej\u015Bciowe";
      case "invalid_element":
        return `Nieprawid\u0142owa warto\u015B\u0107 w ${n.origin}`;
      default:
        return "Nieprawid\u0142owe dane wej\u015Bciowe";
    }
  };
};
function U_() {
  return { localeError: uW() };
}
var dW = () => {
  let e = { string: { unit: "caracteres", verb: "ter" }, file: { unit: "bytes", verb: "ter" }, array: { unit: "itens", verb: "ter" }, set: { unit: "itens", verb: "ter" } };
  function t(n) {
    return e[n] ?? null;
  }
  let r = (n) => {
    let i = typeof n;
    switch (i) {
      case "number":
        return Number.isNaN(n) ? "NaN" : "n\xFAmero";
      case "object": {
        if (Array.isArray(n)) return "array";
        if (n === null) return "nulo";
        if (Object.getPrototypeOf(n) !== Object.prototype && n.constructor) return n.constructor.name;
      }
    }
    return i;
  }, o = { regex: "padr\xE3o", email: "endere\xE7o de e-mail", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "data e hora ISO", date: "data ISO", time: "hora ISO", duration: "dura\xE7\xE3o ISO", ipv4: "endere\xE7o IPv4", ipv6: "endere\xE7o IPv6", cidrv4: "faixa de IPv4", cidrv6: "faixa de IPv6", base64: "texto codificado em base64", base64url: "URL codificada em base64", json_string: "texto JSON", e164: "n\xFAmero E.164", jwt: "JWT", template_literal: "entrada" };
  return (n) => {
    switch (n.code) {
      case "invalid_type":
        return `Tipo inv\xE1lido: esperado ${n.expected}, recebido ${r(n.input)}`;
      case "invalid_value":
        if (n.values.length === 1) return `Entrada inv\xE1lida: esperado ${D(n.values[0])}`;
        return `Op\xE7\xE3o inv\xE1lida: esperada uma das ${P(n.values, "|")}`;
      case "too_big": {
        let i = n.inclusive ? "<=" : "<", s = t(n.origin);
        if (s) return `Muito grande: esperado que ${n.origin ?? "valor"} tivesse ${i}${n.maximum.toString()} ${s.unit ?? "elementos"}`;
        return `Muito grande: esperado que ${n.origin ?? "valor"} fosse ${i}${n.maximum.toString()}`;
      }
      case "too_small": {
        let i = n.inclusive ? ">=" : ">", s = t(n.origin);
        if (s) return `Muito pequeno: esperado que ${n.origin} tivesse ${i}${n.minimum.toString()} ${s.unit}`;
        return `Muito pequeno: esperado que ${n.origin} fosse ${i}${n.minimum.toString()}`;
      }
      case "invalid_format": {
        let i = n;
        if (i.format === "starts_with") return `Texto inv\xE1lido: deve come\xE7ar com "${i.prefix}"`;
        if (i.format === "ends_with") return `Texto inv\xE1lido: deve terminar com "${i.suffix}"`;
        if (i.format === "includes") return `Texto inv\xE1lido: deve incluir "${i.includes}"`;
        if (i.format === "regex") return `Texto inv\xE1lido: deve corresponder ao padr\xE3o ${i.pattern}`;
        return `${o[i.format] ?? n.format} inv\xE1lido`;
      }
      case "not_multiple_of":
        return `N\xFAmero inv\xE1lido: deve ser m\xFAltiplo de ${n.divisor}`;
      case "unrecognized_keys":
        return `Chave${n.keys.length > 1 ? "s" : ""} desconhecida${n.keys.length > 1 ? "s" : ""}: ${P(n.keys, ", ")}`;
      case "invalid_key":
        return `Chave inv\xE1lida em ${n.origin}`;
      case "invalid_union":
        return "Entrada inv\xE1lida";
      case "invalid_element":
        return `Valor inv\xE1lido em ${n.origin}`;
      default:
        return "Campo inv\xE1lido";
    }
  };
};
function z_() {
  return { localeError: dW() };
}
function g$(e, t, r, o) {
  let n = Math.abs(e), i = n % 10, s = n % 100;
  if (s >= 11 && s <= 19) return o;
  if (i === 1) return t;
  if (i >= 2 && i <= 4) return r;
  return o;
}
var pW = () => {
  let e = { string: { unit: { one: "\u0441\u0438\u043C\u0432\u043E\u043B", few: "\u0441\u0438\u043C\u0432\u043E\u043B\u0430", many: "\u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432" }, verb: "\u0438\u043C\u0435\u0442\u044C" }, file: { unit: { one: "\u0431\u0430\u0439\u0442", few: "\u0431\u0430\u0439\u0442\u0430", many: "\u0431\u0430\u0439\u0442" }, verb: "\u0438\u043C\u0435\u0442\u044C" }, array: { unit: { one: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442", few: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u0430", many: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u043E\u0432" }, verb: "\u0438\u043C\u0435\u0442\u044C" }, set: { unit: { one: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442", few: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u0430", many: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u043E\u0432" }, verb: "\u0438\u043C\u0435\u0442\u044C" } };
  function t(n) {
    return e[n] ?? null;
  }
  let r = (n) => {
    let i = typeof n;
    switch (i) {
      case "number":
        return Number.isNaN(n) ? "NaN" : "\u0447\u0438\u0441\u043B\u043E";
      case "object": {
        if (Array.isArray(n)) return "\u043C\u0430\u0441\u0441\u0438\u0432";
        if (n === null) return "null";
        if (Object.getPrototypeOf(n) !== Object.prototype && n.constructor) return n.constructor.name;
      }
    }
    return i;
  }, o = { regex: "\u0432\u0432\u043E\u0434", email: "email \u0430\u0434\u0440\u0435\u0441", url: "URL", emoji: "\u044D\u043C\u043E\u0434\u0437\u0438", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO \u0434\u0430\u0442\u0430 \u0438 \u0432\u0440\u0435\u043C\u044F", date: "ISO \u0434\u0430\u0442\u0430", time: "ISO \u0432\u0440\u0435\u043C\u044F", duration: "ISO \u0434\u043B\u0438\u0442\u0435\u043B\u044C\u043D\u043E\u0441\u0442\u044C", ipv4: "IPv4 \u0430\u0434\u0440\u0435\u0441", ipv6: "IPv6 \u0430\u0434\u0440\u0435\u0441", cidrv4: "IPv4 \u0434\u0438\u0430\u043F\u0430\u0437\u043E\u043D", cidrv6: "IPv6 \u0434\u0438\u0430\u043F\u0430\u0437\u043E\u043D", base64: "\u0441\u0442\u0440\u043E\u043A\u0430 \u0432 \u0444\u043E\u0440\u043C\u0430\u0442\u0435 base64", base64url: "\u0441\u0442\u0440\u043E\u043A\u0430 \u0432 \u0444\u043E\u0440\u043C\u0430\u0442\u0435 base64url", json_string: "JSON \u0441\u0442\u0440\u043E\u043A\u0430", e164: "\u043D\u043E\u043C\u0435\u0440 E.164", jwt: "JWT", template_literal: "\u0432\u0432\u043E\u0434" };
  return (n) => {
    switch (n.code) {
      case "invalid_type":
        return `\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u0432\u0432\u043E\u0434: \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C ${n.expected}, \u043F\u043E\u043B\u0443\u0447\u0435\u043D\u043E ${r(n.input)}`;
      case "invalid_value":
        if (n.values.length === 1) return `\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u0432\u0432\u043E\u0434: \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C ${D(n.values[0])}`;
        return `\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u0432\u0430\u0440\u0438\u0430\u043D\u0442: \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C \u043E\u0434\u043D\u043E \u0438\u0437 ${P(n.values, "|")}`;
      case "too_big": {
        let i = n.inclusive ? "<=" : "<", s = t(n.origin);
        if (s) {
          let a = Number(n.maximum), c = g$(a, s.unit.one, s.unit.few, s.unit.many);
          return `\u0421\u043B\u0438\u0448\u043A\u043E\u043C \u0431\u043E\u043B\u044C\u0448\u043E\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435: \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C, \u0447\u0442\u043E ${n.origin ?? "\u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435"} \u0431\u0443\u0434\u0435\u0442 \u0438\u043C\u0435\u0442\u044C ${i}${n.maximum.toString()} ${c}`;
        }
        return `\u0421\u043B\u0438\u0448\u043A\u043E\u043C \u0431\u043E\u043B\u044C\u0448\u043E\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435: \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C, \u0447\u0442\u043E ${n.origin ?? "\u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435"} \u0431\u0443\u0434\u0435\u0442 ${i}${n.maximum.toString()}`;
      }
      case "too_small": {
        let i = n.inclusive ? ">=" : ">", s = t(n.origin);
        if (s) {
          let a = Number(n.minimum), c = g$(a, s.unit.one, s.unit.few, s.unit.many);
          return `\u0421\u043B\u0438\u0448\u043A\u043E\u043C \u043C\u0430\u043B\u0435\u043D\u044C\u043A\u043E\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435: \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C, \u0447\u0442\u043E ${n.origin} \u0431\u0443\u0434\u0435\u0442 \u0438\u043C\u0435\u0442\u044C ${i}${n.minimum.toString()} ${c}`;
        }
        return `\u0421\u043B\u0438\u0448\u043A\u043E\u043C \u043C\u0430\u043B\u0435\u043D\u044C\u043A\u043E\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435: \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C, \u0447\u0442\u043E ${n.origin} \u0431\u0443\u0434\u0435\u0442 ${i}${n.minimum.toString()}`;
      }
      case "invalid_format": {
        let i = n;
        if (i.format === "starts_with") return `\u041D\u0435\u0432\u0435\u0440\u043D\u0430\u044F \u0441\u0442\u0440\u043E\u043A\u0430: \u0434\u043E\u043B\u0436\u043D\u0430 \u043D\u0430\u0447\u0438\u043D\u0430\u0442\u044C\u0441\u044F \u0441 "${i.prefix}"`;
        if (i.format === "ends_with") return `\u041D\u0435\u0432\u0435\u0440\u043D\u0430\u044F \u0441\u0442\u0440\u043E\u043A\u0430: \u0434\u043E\u043B\u0436\u043D\u0430 \u0437\u0430\u043A\u0430\u043D\u0447\u0438\u0432\u0430\u0442\u044C\u0441\u044F \u043D\u0430 "${i.suffix}"`;
        if (i.format === "includes") return `\u041D\u0435\u0432\u0435\u0440\u043D\u0430\u044F \u0441\u0442\u0440\u043E\u043A\u0430: \u0434\u043E\u043B\u0436\u043D\u0430 \u0441\u043E\u0434\u0435\u0440\u0436\u0430\u0442\u044C "${i.includes}"`;
        if (i.format === "regex") return `\u041D\u0435\u0432\u0435\u0440\u043D\u0430\u044F \u0441\u0442\u0440\u043E\u043A\u0430: \u0434\u043E\u043B\u0436\u043D\u0430 \u0441\u043E\u043E\u0442\u0432\u0435\u0442\u0441\u0442\u0432\u043E\u0432\u0430\u0442\u044C \u0448\u0430\u0431\u043B\u043E\u043D\u0443 ${i.pattern}`;
        return `\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 ${o[i.format] ?? n.format}`;
      }
      case "not_multiple_of":
        return `\u041D\u0435\u0432\u0435\u0440\u043D\u043E\u0435 \u0447\u0438\u0441\u043B\u043E: \u0434\u043E\u043B\u0436\u043D\u043E \u0431\u044B\u0442\u044C \u043A\u0440\u0430\u0442\u043D\u044B\u043C ${n.divisor}`;
      case "unrecognized_keys":
        return `\u041D\u0435\u0440\u0430\u0441\u043F\u043E\u0437\u043D\u0430\u043D\u043D${n.keys.length > 1 ? "\u044B\u0435" : "\u044B\u0439"} \u043A\u043B\u044E\u0447${n.keys.length > 1 ? "\u0438" : ""}: ${P(n.keys, ", ")}`;
      case "invalid_key":
        return `\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u043A\u043B\u044E\u0447 \u0432 ${n.origin}`;
      case "invalid_union":
        return "\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0435 \u0432\u0445\u043E\u0434\u043D\u044B\u0435 \u0434\u0430\u043D\u043D\u044B\u0435";
      case "invalid_element":
        return `\u041D\u0435\u0432\u0435\u0440\u043D\u043E\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435 \u0432 ${n.origin}`;
      default:
        return "\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0435 \u0432\u0445\u043E\u0434\u043D\u044B\u0435 \u0434\u0430\u043D\u043D\u044B\u0435";
    }
  };
};
function L_() {
  return { localeError: pW() };
}
var fW = () => {
  let e = { string: { unit: "znakov", verb: "imeti" }, file: { unit: "bajtov", verb: "imeti" }, array: { unit: "elementov", verb: "imeti" }, set: { unit: "elementov", verb: "imeti" } };
  function t(n) {
    return e[n] ?? null;
  }
  let r = (n) => {
    let i = typeof n;
    switch (i) {
      case "number":
        return Number.isNaN(n) ? "NaN" : "\u0161tevilo";
      case "object": {
        if (Array.isArray(n)) return "tabela";
        if (n === null) return "null";
        if (Object.getPrototypeOf(n) !== Object.prototype && n.constructor) return n.constructor.name;
      }
    }
    return i;
  }, o = { regex: "vnos", email: "e-po\u0161tni naslov", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO datum in \u010Das", date: "ISO datum", time: "ISO \u010Das", duration: "ISO trajanje", ipv4: "IPv4 naslov", ipv6: "IPv6 naslov", cidrv4: "obseg IPv4", cidrv6: "obseg IPv6", base64: "base64 kodiran niz", base64url: "base64url kodiran niz", json_string: "JSON niz", e164: "E.164 \u0161tevilka", jwt: "JWT", template_literal: "vnos" };
  return (n) => {
    switch (n.code) {
      case "invalid_type":
        return `Neveljaven vnos: pri\u010Dakovano ${n.expected}, prejeto ${r(n.input)}`;
      case "invalid_value":
        if (n.values.length === 1) return `Neveljaven vnos: pri\u010Dakovano ${D(n.values[0])}`;
        return `Neveljavna mo\u017Enost: pri\u010Dakovano eno izmed ${P(n.values, "|")}`;
      case "too_big": {
        let i = n.inclusive ? "<=" : "<", s = t(n.origin);
        if (s) return `Preveliko: pri\u010Dakovano, da bo ${n.origin ?? "vrednost"} imelo ${i}${n.maximum.toString()} ${s.unit ?? "elementov"}`;
        return `Preveliko: pri\u010Dakovano, da bo ${n.origin ?? "vrednost"} ${i}${n.maximum.toString()}`;
      }
      case "too_small": {
        let i = n.inclusive ? ">=" : ">", s = t(n.origin);
        if (s) return `Premajhno: pri\u010Dakovano, da bo ${n.origin} imelo ${i}${n.minimum.toString()} ${s.unit}`;
        return `Premajhno: pri\u010Dakovano, da bo ${n.origin} ${i}${n.minimum.toString()}`;
      }
      case "invalid_format": {
        let i = n;
        if (i.format === "starts_with") return `Neveljaven niz: mora se za\u010Deti z "${i.prefix}"`;
        if (i.format === "ends_with") return `Neveljaven niz: mora se kon\u010Dati z "${i.suffix}"`;
        if (i.format === "includes") return `Neveljaven niz: mora vsebovati "${i.includes}"`;
        if (i.format === "regex") return `Neveljaven niz: mora ustrezati vzorcu ${i.pattern}`;
        return `Neveljaven ${o[i.format] ?? n.format}`;
      }
      case "not_multiple_of":
        return `Neveljavno \u0161tevilo: mora biti ve\u010Dkratnik ${n.divisor}`;
      case "unrecognized_keys":
        return `Neprepoznan${n.keys.length > 1 ? "i klju\u010Di" : " klju\u010D"}: ${P(n.keys, ", ")}`;
      case "invalid_key":
        return `Neveljaven klju\u010D v ${n.origin}`;
      case "invalid_union":
        return "Neveljaven vnos";
      case "invalid_element":
        return `Neveljavna vrednost v ${n.origin}`;
      default:
        return "Neveljaven vnos";
    }
  };
};
function F_() {
  return { localeError: fW() };
}
var mW = () => {
  let e = { string: { unit: "tecken", verb: "att ha" }, file: { unit: "bytes", verb: "att ha" }, array: { unit: "objekt", verb: "att inneh\xE5lla" }, set: { unit: "objekt", verb: "att inneh\xE5lla" } };
  function t(n) {
    return e[n] ?? null;
  }
  let r = (n) => {
    let i = typeof n;
    switch (i) {
      case "number":
        return Number.isNaN(n) ? "NaN" : "antal";
      case "object": {
        if (Array.isArray(n)) return "lista";
        if (n === null) return "null";
        if (Object.getPrototypeOf(n) !== Object.prototype && n.constructor) return n.constructor.name;
      }
    }
    return i;
  }, o = { regex: "regulj\xE4rt uttryck", email: "e-postadress", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO-datum och tid", date: "ISO-datum", time: "ISO-tid", duration: "ISO-varaktighet", ipv4: "IPv4-intervall", ipv6: "IPv6-intervall", cidrv4: "IPv4-spektrum", cidrv6: "IPv6-spektrum", base64: "base64-kodad str\xE4ng", base64url: "base64url-kodad str\xE4ng", json_string: "JSON-str\xE4ng", e164: "E.164-nummer", jwt: "JWT", template_literal: "mall-literal" };
  return (n) => {
    switch (n.code) {
      case "invalid_type":
        return `Ogiltig inmatning: f\xF6rv\xE4ntat ${n.expected}, fick ${r(n.input)}`;
      case "invalid_value":
        if (n.values.length === 1) return `Ogiltig inmatning: f\xF6rv\xE4ntat ${D(n.values[0])}`;
        return `Ogiltigt val: f\xF6rv\xE4ntade en av ${P(n.values, "|")}`;
      case "too_big": {
        let i = n.inclusive ? "<=" : "<", s = t(n.origin);
        if (s) return `F\xF6r stor(t): f\xF6rv\xE4ntade ${n.origin ?? "v\xE4rdet"} att ha ${i}${n.maximum.toString()} ${s.unit ?? "element"}`;
        return `F\xF6r stor(t): f\xF6rv\xE4ntat ${n.origin ?? "v\xE4rdet"} att ha ${i}${n.maximum.toString()}`;
      }
      case "too_small": {
        let i = n.inclusive ? ">=" : ">", s = t(n.origin);
        if (s) return `F\xF6r lite(t): f\xF6rv\xE4ntade ${n.origin ?? "v\xE4rdet"} att ha ${i}${n.minimum.toString()} ${s.unit}`;
        return `F\xF6r lite(t): f\xF6rv\xE4ntade ${n.origin ?? "v\xE4rdet"} att ha ${i}${n.minimum.toString()}`;
      }
      case "invalid_format": {
        let i = n;
        if (i.format === "starts_with") return `Ogiltig str\xE4ng: m\xE5ste b\xF6rja med "${i.prefix}"`;
        if (i.format === "ends_with") return `Ogiltig str\xE4ng: m\xE5ste sluta med "${i.suffix}"`;
        if (i.format === "includes") return `Ogiltig str\xE4ng: m\xE5ste inneh\xE5lla "${i.includes}"`;
        if (i.format === "regex") return `Ogiltig str\xE4ng: m\xE5ste matcha m\xF6nstret "${i.pattern}"`;
        return `Ogiltig(t) ${o[i.format] ?? n.format}`;
      }
      case "not_multiple_of":
        return `Ogiltigt tal: m\xE5ste vara en multipel av ${n.divisor}`;
      case "unrecognized_keys":
        return `${n.keys.length > 1 ? "Ok\xE4nda nycklar" : "Ok\xE4nd nyckel"}: ${P(n.keys, ", ")}`;
      case "invalid_key":
        return `Ogiltig nyckel i ${n.origin ?? "v\xE4rdet"}`;
      case "invalid_union":
        return "Ogiltig input";
      case "invalid_element":
        return `Ogiltigt v\xE4rde i ${n.origin ?? "v\xE4rdet"}`;
      default:
        return "Ogiltig input";
    }
  };
};
function H_() {
  return { localeError: mW() };
}
var gW = () => {
  let e = { string: { unit: "\u0B8E\u0BB4\u0BC1\u0BA4\u0BCD\u0BA4\u0BC1\u0B95\u0BCD\u0B95\u0BB3\u0BCD", verb: "\u0B95\u0BCA\u0BA3\u0BCD\u0B9F\u0BBF\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD" }, file: { unit: "\u0BAA\u0BC8\u0B9F\u0BCD\u0B9F\u0BC1\u0B95\u0BB3\u0BCD", verb: "\u0B95\u0BCA\u0BA3\u0BCD\u0B9F\u0BBF\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD" }, array: { unit: "\u0B89\u0BB1\u0BC1\u0BAA\u0BCD\u0BAA\u0BC1\u0B95\u0BB3\u0BCD", verb: "\u0B95\u0BCA\u0BA3\u0BCD\u0B9F\u0BBF\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD" }, set: { unit: "\u0B89\u0BB1\u0BC1\u0BAA\u0BCD\u0BAA\u0BC1\u0B95\u0BB3\u0BCD", verb: "\u0B95\u0BCA\u0BA3\u0BCD\u0B9F\u0BBF\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD" } };
  function t(n) {
    return e[n] ?? null;
  }
  let r = (n) => {
    let i = typeof n;
    switch (i) {
      case "number":
        return Number.isNaN(n) ? "\u0B8E\u0BA3\u0BCD \u0B85\u0BB2\u0BCD\u0BB2\u0BBE\u0BA4\u0BA4\u0BC1" : "\u0B8E\u0BA3\u0BCD";
      case "object": {
        if (Array.isArray(n)) return "\u0B85\u0BA3\u0BBF";
        if (n === null) return "\u0BB5\u0BC6\u0BB1\u0BC1\u0BAE\u0BC8";
        if (Object.getPrototypeOf(n) !== Object.prototype && n.constructor) return n.constructor.name;
      }
    }
    return i;
  }, o = { regex: "\u0B89\u0BB3\u0BCD\u0BB3\u0BC0\u0B9F\u0BC1", email: "\u0BAE\u0BBF\u0BA9\u0BCD\u0BA9\u0B9E\u0BCD\u0B9A\u0BB2\u0BCD \u0BAE\u0BC1\u0B95\u0BB5\u0BB0\u0BBF", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO \u0BA4\u0BC7\u0BA4\u0BBF \u0BA8\u0BC7\u0BB0\u0BAE\u0BCD", date: "ISO \u0BA4\u0BC7\u0BA4\u0BBF", time: "ISO \u0BA8\u0BC7\u0BB0\u0BAE\u0BCD", duration: "ISO \u0B95\u0BBE\u0BB2 \u0B85\u0BB3\u0BB5\u0BC1", ipv4: "IPv4 \u0BAE\u0BC1\u0B95\u0BB5\u0BB0\u0BBF", ipv6: "IPv6 \u0BAE\u0BC1\u0B95\u0BB5\u0BB0\u0BBF", cidrv4: "IPv4 \u0BB5\u0BB0\u0BAE\u0BCD\u0BAA\u0BC1", cidrv6: "IPv6 \u0BB5\u0BB0\u0BAE\u0BCD\u0BAA\u0BC1", base64: "base64-encoded \u0B9A\u0BB0\u0BAE\u0BCD", base64url: "base64url-encoded \u0B9A\u0BB0\u0BAE\u0BCD", json_string: "JSON \u0B9A\u0BB0\u0BAE\u0BCD", e164: "E.164 \u0B8E\u0BA3\u0BCD", jwt: "JWT", template_literal: "input" };
  return (n) => {
    switch (n.code) {
      case "invalid_type":
        return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B89\u0BB3\u0BCD\u0BB3\u0BC0\u0B9F\u0BC1: \u0B8E\u0BA4\u0BBF\u0BB0\u0BCD\u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${n.expected}, \u0BAA\u0BC6\u0BB1\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${r(n.input)}`;
      case "invalid_value":
        if (n.values.length === 1) return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B89\u0BB3\u0BCD\u0BB3\u0BC0\u0B9F\u0BC1: \u0B8E\u0BA4\u0BBF\u0BB0\u0BCD\u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${D(n.values[0])}`;
        return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0BB5\u0BBF\u0BB0\u0BC1\u0BAA\u0BCD\u0BAA\u0BAE\u0BCD: \u0B8E\u0BA4\u0BBF\u0BB0\u0BCD\u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${P(n.values, "|")} \u0B87\u0BB2\u0BCD \u0B92\u0BA9\u0BCD\u0BB1\u0BC1`;
      case "too_big": {
        let i = n.inclusive ? "<=" : "<", s = t(n.origin);
        if (s) return `\u0BAE\u0BBF\u0B95 \u0BAA\u0BC6\u0BB0\u0BBF\u0BAF\u0BA4\u0BC1: \u0B8E\u0BA4\u0BBF\u0BB0\u0BCD\u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${n.origin ?? "\u0BAE\u0BA4\u0BBF\u0BAA\u0BCD\u0BAA\u0BC1"} ${i}${n.maximum.toString()} ${s.unit ?? "\u0B89\u0BB1\u0BC1\u0BAA\u0BCD\u0BAA\u0BC1\u0B95\u0BB3\u0BCD"} \u0B86\u0B95 \u0B87\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
        return `\u0BAE\u0BBF\u0B95 \u0BAA\u0BC6\u0BB0\u0BBF\u0BAF\u0BA4\u0BC1: \u0B8E\u0BA4\u0BBF\u0BB0\u0BCD\u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${n.origin ?? "\u0BAE\u0BA4\u0BBF\u0BAA\u0BCD\u0BAA\u0BC1"} ${i}${n.maximum.toString()} \u0B86\u0B95 \u0B87\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
      }
      case "too_small": {
        let i = n.inclusive ? ">=" : ">", s = t(n.origin);
        if (s) return `\u0BAE\u0BBF\u0B95\u0B9A\u0BCD \u0B9A\u0BBF\u0BB1\u0BBF\u0BAF\u0BA4\u0BC1: \u0B8E\u0BA4\u0BBF\u0BB0\u0BCD\u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${n.origin} ${i}${n.minimum.toString()} ${s.unit} \u0B86\u0B95 \u0B87\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
        return `\u0BAE\u0BBF\u0B95\u0B9A\u0BCD \u0B9A\u0BBF\u0BB1\u0BBF\u0BAF\u0BA4\u0BC1: \u0B8E\u0BA4\u0BBF\u0BB0\u0BCD\u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${n.origin} ${i}${n.minimum.toString()} \u0B86\u0B95 \u0B87\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
      }
      case "invalid_format": {
        let i = n;
        if (i.format === "starts_with") return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B9A\u0BB0\u0BAE\u0BCD: "${i.prefix}" \u0B87\u0BB2\u0BCD \u0BA4\u0BCA\u0B9F\u0B99\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
        if (i.format === "ends_with") return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B9A\u0BB0\u0BAE\u0BCD: "${i.suffix}" \u0B87\u0BB2\u0BCD \u0BAE\u0BC1\u0B9F\u0BBF\u0BB5\u0B9F\u0BC8\u0BAF \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
        if (i.format === "includes") return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B9A\u0BB0\u0BAE\u0BCD: "${i.includes}" \u0B90 \u0B89\u0BB3\u0BCD\u0BB3\u0B9F\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
        if (i.format === "regex") return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B9A\u0BB0\u0BAE\u0BCD: ${i.pattern} \u0BAE\u0BC1\u0BB1\u0BC8\u0BAA\u0BBE\u0B9F\u0BCD\u0B9F\u0BC1\u0B9F\u0BA9\u0BCD \u0BAA\u0BCA\u0BB0\u0BC1\u0BA8\u0BCD\u0BA4 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
        return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 ${o[i.format] ?? n.format}`;
      }
      case "not_multiple_of":
        return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B8E\u0BA3\u0BCD: ${n.divisor} \u0B87\u0BA9\u0BCD \u0BAA\u0BB2\u0BAE\u0BBE\u0B95 \u0B87\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
      case "unrecognized_keys":
        return `\u0B85\u0B9F\u0BC8\u0BAF\u0BBE\u0BB3\u0BAE\u0BCD \u0BA4\u0BC6\u0BB0\u0BBF\u0BAF\u0BBE\u0BA4 \u0BB5\u0BBF\u0B9A\u0BC8${n.keys.length > 1 ? "\u0B95\u0BB3\u0BCD" : ""}: ${P(n.keys, ", ")}`;
      case "invalid_key":
        return `${n.origin} \u0B87\u0BB2\u0BCD \u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0BB5\u0BBF\u0B9A\u0BC8`;
      case "invalid_union":
        return "\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B89\u0BB3\u0BCD\u0BB3\u0BC0\u0B9F\u0BC1";
      case "invalid_element":
        return `${n.origin} \u0B87\u0BB2\u0BCD \u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0BAE\u0BA4\u0BBF\u0BAA\u0BCD\u0BAA\u0BC1`;
      default:
        return "\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B89\u0BB3\u0BCD\u0BB3\u0BC0\u0B9F\u0BC1";
    }
  };
};
function B_() {
  return { localeError: gW() };
}
var hW = () => {
  let e = { string: { unit: "\u0E15\u0E31\u0E27\u0E2D\u0E31\u0E01\u0E29\u0E23", verb: "\u0E04\u0E27\u0E23\u0E21\u0E35" }, file: { unit: "\u0E44\u0E1A\u0E15\u0E4C", verb: "\u0E04\u0E27\u0E23\u0E21\u0E35" }, array: { unit: "\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23", verb: "\u0E04\u0E27\u0E23\u0E21\u0E35" }, set: { unit: "\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23", verb: "\u0E04\u0E27\u0E23\u0E21\u0E35" } };
  function t(n) {
    return e[n] ?? null;
  }
  let r = (n) => {
    let i = typeof n;
    switch (i) {
      case "number":
        return Number.isNaN(n) ? "\u0E44\u0E21\u0E48\u0E43\u0E0A\u0E48\u0E15\u0E31\u0E27\u0E40\u0E25\u0E02 (NaN)" : "\u0E15\u0E31\u0E27\u0E40\u0E25\u0E02";
      case "object": {
        if (Array.isArray(n)) return "\u0E2D\u0E32\u0E23\u0E4C\u0E40\u0E23\u0E22\u0E4C (Array)";
        if (n === null) return "\u0E44\u0E21\u0E48\u0E21\u0E35\u0E04\u0E48\u0E32 (null)";
        if (Object.getPrototypeOf(n) !== Object.prototype && n.constructor) return n.constructor.name;
      }
    }
    return i;
  }, o = { regex: "\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E17\u0E35\u0E48\u0E1B\u0E49\u0E2D\u0E19", email: "\u0E17\u0E35\u0E48\u0E2D\u0E22\u0E39\u0E48\u0E2D\u0E35\u0E40\u0E21\u0E25", url: "URL", emoji: "\u0E2D\u0E34\u0E42\u0E21\u0E08\u0E34", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "\u0E27\u0E31\u0E19\u0E17\u0E35\u0E48\u0E40\u0E27\u0E25\u0E32\u0E41\u0E1A\u0E1A ISO", date: "\u0E27\u0E31\u0E19\u0E17\u0E35\u0E48\u0E41\u0E1A\u0E1A ISO", time: "\u0E40\u0E27\u0E25\u0E32\u0E41\u0E1A\u0E1A ISO", duration: "\u0E0A\u0E48\u0E27\u0E07\u0E40\u0E27\u0E25\u0E32\u0E41\u0E1A\u0E1A ISO", ipv4: "\u0E17\u0E35\u0E48\u0E2D\u0E22\u0E39\u0E48 IPv4", ipv6: "\u0E17\u0E35\u0E48\u0E2D\u0E22\u0E39\u0E48 IPv6", cidrv4: "\u0E0A\u0E48\u0E27\u0E07 IP \u0E41\u0E1A\u0E1A IPv4", cidrv6: "\u0E0A\u0E48\u0E27\u0E07 IP \u0E41\u0E1A\u0E1A IPv6", base64: "\u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E41\u0E1A\u0E1A Base64", base64url: "\u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E41\u0E1A\u0E1A Base64 \u0E2A\u0E33\u0E2B\u0E23\u0E31\u0E1A URL", json_string: "\u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E41\u0E1A\u0E1A JSON", e164: "\u0E40\u0E1A\u0E2D\u0E23\u0E4C\u0E42\u0E17\u0E23\u0E28\u0E31\u0E1E\u0E17\u0E4C\u0E23\u0E30\u0E2B\u0E27\u0E48\u0E32\u0E07\u0E1B\u0E23\u0E30\u0E40\u0E17\u0E28 (E.164)", jwt: "\u0E42\u0E17\u0E40\u0E04\u0E19 JWT", template_literal: "\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E17\u0E35\u0E48\u0E1B\u0E49\u0E2D\u0E19" };
  return (n) => {
    switch (n.code) {
      case "invalid_type":
        return `\u0E1B\u0E23\u0E30\u0E40\u0E20\u0E17\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E04\u0E27\u0E23\u0E40\u0E1B\u0E47\u0E19 ${n.expected} \u0E41\u0E15\u0E48\u0E44\u0E14\u0E49\u0E23\u0E31\u0E1A ${r(n.input)}`;
      case "invalid_value":
        if (n.values.length === 1) return `\u0E04\u0E48\u0E32\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E04\u0E27\u0E23\u0E40\u0E1B\u0E47\u0E19 ${D(n.values[0])}`;
        return `\u0E15\u0E31\u0E27\u0E40\u0E25\u0E37\u0E2D\u0E01\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E04\u0E27\u0E23\u0E40\u0E1B\u0E47\u0E19\u0E2B\u0E19\u0E36\u0E48\u0E07\u0E43\u0E19 ${P(n.values, "|")}`;
      case "too_big": {
        let i = n.inclusive ? "\u0E44\u0E21\u0E48\u0E40\u0E01\u0E34\u0E19" : "\u0E19\u0E49\u0E2D\u0E22\u0E01\u0E27\u0E48\u0E32", s = t(n.origin);
        if (s) return `\u0E40\u0E01\u0E34\u0E19\u0E01\u0E33\u0E2B\u0E19\u0E14: ${n.origin ?? "\u0E04\u0E48\u0E32"} \u0E04\u0E27\u0E23\u0E21\u0E35${i} ${n.maximum.toString()} ${s.unit ?? "\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23"}`;
        return `\u0E40\u0E01\u0E34\u0E19\u0E01\u0E33\u0E2B\u0E19\u0E14: ${n.origin ?? "\u0E04\u0E48\u0E32"} \u0E04\u0E27\u0E23\u0E21\u0E35${i} ${n.maximum.toString()}`;
      }
      case "too_small": {
        let i = n.inclusive ? "\u0E2D\u0E22\u0E48\u0E32\u0E07\u0E19\u0E49\u0E2D\u0E22" : "\u0E21\u0E32\u0E01\u0E01\u0E27\u0E48\u0E32", s = t(n.origin);
        if (s) return `\u0E19\u0E49\u0E2D\u0E22\u0E01\u0E27\u0E48\u0E32\u0E01\u0E33\u0E2B\u0E19\u0E14: ${n.origin} \u0E04\u0E27\u0E23\u0E21\u0E35${i} ${n.minimum.toString()} ${s.unit}`;
        return `\u0E19\u0E49\u0E2D\u0E22\u0E01\u0E27\u0E48\u0E32\u0E01\u0E33\u0E2B\u0E19\u0E14: ${n.origin} \u0E04\u0E27\u0E23\u0E21\u0E35${i} ${n.minimum.toString()}`;
      }
      case "invalid_format": {
        let i = n;
        if (i.format === "starts_with") return `\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E15\u0E49\u0E2D\u0E07\u0E02\u0E36\u0E49\u0E19\u0E15\u0E49\u0E19\u0E14\u0E49\u0E27\u0E22 "${i.prefix}"`;
        if (i.format === "ends_with") return `\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E15\u0E49\u0E2D\u0E07\u0E25\u0E07\u0E17\u0E49\u0E32\u0E22\u0E14\u0E49\u0E27\u0E22 "${i.suffix}"`;
        if (i.format === "includes") return `\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E15\u0E49\u0E2D\u0E07\u0E21\u0E35 "${i.includes}" \u0E2D\u0E22\u0E39\u0E48\u0E43\u0E19\u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21`;
        if (i.format === "regex") return `\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E15\u0E49\u0E2D\u0E07\u0E15\u0E23\u0E07\u0E01\u0E31\u0E1A\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E17\u0E35\u0E48\u0E01\u0E33\u0E2B\u0E19\u0E14 ${i.pattern}`;
        return `\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: ${o[i.format] ?? n.format}`;
      }
      case "not_multiple_of":
        return `\u0E15\u0E31\u0E27\u0E40\u0E25\u0E02\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E15\u0E49\u0E2D\u0E07\u0E40\u0E1B\u0E47\u0E19\u0E08\u0E33\u0E19\u0E27\u0E19\u0E17\u0E35\u0E48\u0E2B\u0E32\u0E23\u0E14\u0E49\u0E27\u0E22 ${n.divisor} \u0E44\u0E14\u0E49\u0E25\u0E07\u0E15\u0E31\u0E27`;
      case "unrecognized_keys":
        return `\u0E1E\u0E1A\u0E04\u0E35\u0E22\u0E4C\u0E17\u0E35\u0E48\u0E44\u0E21\u0E48\u0E23\u0E39\u0E49\u0E08\u0E31\u0E01: ${P(n.keys, ", ")}`;
      case "invalid_key":
        return `\u0E04\u0E35\u0E22\u0E4C\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07\u0E43\u0E19 ${n.origin}`;
      case "invalid_union":
        return "\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E44\u0E21\u0E48\u0E15\u0E23\u0E07\u0E01\u0E31\u0E1A\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E22\u0E39\u0E40\u0E19\u0E35\u0E22\u0E19\u0E17\u0E35\u0E48\u0E01\u0E33\u0E2B\u0E19\u0E14\u0E44\u0E27\u0E49";
      case "invalid_element":
        return `\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07\u0E43\u0E19 ${n.origin}`;
      default:
        return "\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07";
    }
  };
};
function q_() {
  return { localeError: hW() };
}
var yW = (e) => {
  let t = typeof e;
  switch (t) {
    case "number":
      return Number.isNaN(e) ? "NaN" : "number";
    case "object": {
      if (Array.isArray(e)) return "array";
      if (e === null) return "null";
      if (Object.getPrototypeOf(e) !== Object.prototype && e.constructor) return e.constructor.name;
    }
  }
  return t;
};
var bW = () => {
  let e = { string: { unit: "karakter", verb: "olmal\u0131" }, file: { unit: "bayt", verb: "olmal\u0131" }, array: { unit: "\xF6\u011Fe", verb: "olmal\u0131" }, set: { unit: "\xF6\u011Fe", verb: "olmal\u0131" } };
  function t(o) {
    return e[o] ?? null;
  }
  let r = { regex: "girdi", email: "e-posta adresi", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO tarih ve saat", date: "ISO tarih", time: "ISO saat", duration: "ISO s\xFCre", ipv4: "IPv4 adresi", ipv6: "IPv6 adresi", cidrv4: "IPv4 aral\u0131\u011F\u0131", cidrv6: "IPv6 aral\u0131\u011F\u0131", base64: "base64 ile \u015Fifrelenmi\u015F metin", base64url: "base64url ile \u015Fifrelenmi\u015F metin", json_string: "JSON dizesi", e164: "E.164 say\u0131s\u0131", jwt: "JWT", template_literal: "\u015Eablon dizesi" };
  return (o) => {
    switch (o.code) {
      case "invalid_type":
        return `Ge\xE7ersiz de\u011Fer: beklenen ${o.expected}, al\u0131nan ${yW(o.input)}`;
      case "invalid_value":
        if (o.values.length === 1) return `Ge\xE7ersiz de\u011Fer: beklenen ${D(o.values[0])}`;
        return `Ge\xE7ersiz se\xE7enek: a\u015Fa\u011F\u0131dakilerden biri olmal\u0131: ${P(o.values, "|")}`;
      case "too_big": {
        let n = o.inclusive ? "<=" : "<", i = t(o.origin);
        if (i) return `\xC7ok b\xFCy\xFCk: beklenen ${o.origin ?? "de\u011Fer"} ${n}${o.maximum.toString()} ${i.unit ?? "\xF6\u011Fe"}`;
        return `\xC7ok b\xFCy\xFCk: beklenen ${o.origin ?? "de\u011Fer"} ${n}${o.maximum.toString()}`;
      }
      case "too_small": {
        let n = o.inclusive ? ">=" : ">", i = t(o.origin);
        if (i) return `\xC7ok k\xFC\xE7\xFCk: beklenen ${o.origin} ${n}${o.minimum.toString()} ${i.unit}`;
        return `\xC7ok k\xFC\xE7\xFCk: beklenen ${o.origin} ${n}${o.minimum.toString()}`;
      }
      case "invalid_format": {
        let n = o;
        if (n.format === "starts_with") return `Ge\xE7ersiz metin: "${n.prefix}" ile ba\u015Flamal\u0131`;
        if (n.format === "ends_with") return `Ge\xE7ersiz metin: "${n.suffix}" ile bitmeli`;
        if (n.format === "includes") return `Ge\xE7ersiz metin: "${n.includes}" i\xE7ermeli`;
        if (n.format === "regex") return `Ge\xE7ersiz metin: ${n.pattern} desenine uymal\u0131`;
        return `Ge\xE7ersiz ${r[n.format] ?? o.format}`;
      }
      case "not_multiple_of":
        return `Ge\xE7ersiz say\u0131: ${o.divisor} ile tam b\xF6l\xFCnebilmeli`;
      case "unrecognized_keys":
        return `Tan\u0131nmayan anahtar${o.keys.length > 1 ? "lar" : ""}: ${P(o.keys, ", ")}`;
      case "invalid_key":
        return `${o.origin} i\xE7inde ge\xE7ersiz anahtar`;
      case "invalid_union":
        return "Ge\xE7ersiz de\u011Fer";
      case "invalid_element":
        return `${o.origin} i\xE7inde ge\xE7ersiz de\u011Fer`;
      default:
        return "Ge\xE7ersiz de\u011Fer";
    }
  };
};
function V_() {
  return { localeError: bW() };
}
var _W = () => {
  let e = { string: { unit: "\u0441\u0438\u043C\u0432\u043E\u043B\u0456\u0432", verb: "\u043C\u0430\u0442\u0438\u043C\u0435" }, file: { unit: "\u0431\u0430\u0439\u0442\u0456\u0432", verb: "\u043C\u0430\u0442\u0438\u043C\u0435" }, array: { unit: "\u0435\u043B\u0435\u043C\u0435\u043D\u0442\u0456\u0432", verb: "\u043C\u0430\u0442\u0438\u043C\u0435" }, set: { unit: "\u0435\u043B\u0435\u043C\u0435\u043D\u0442\u0456\u0432", verb: "\u043C\u0430\u0442\u0438\u043C\u0435" } };
  function t(n) {
    return e[n] ?? null;
  }
  let r = (n) => {
    let i = typeof n;
    switch (i) {
      case "number":
        return Number.isNaN(n) ? "NaN" : "\u0447\u0438\u0441\u043B\u043E";
      case "object": {
        if (Array.isArray(n)) return "\u043C\u0430\u0441\u0438\u0432";
        if (n === null) return "null";
        if (Object.getPrototypeOf(n) !== Object.prototype && n.constructor) return n.constructor.name;
      }
    }
    return i;
  }, o = { regex: "\u0432\u0445\u0456\u0434\u043D\u0456 \u0434\u0430\u043D\u0456", email: "\u0430\u0434\u0440\u0435\u0441\u0430 \u0435\u043B\u0435\u043A\u0442\u0440\u043E\u043D\u043D\u043E\u0457 \u043F\u043E\u0448\u0442\u0438", url: "URL", emoji: "\u0435\u043C\u043E\u0434\u0437\u0456", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "\u0434\u0430\u0442\u0430 \u0442\u0430 \u0447\u0430\u0441 ISO", date: "\u0434\u0430\u0442\u0430 ISO", time: "\u0447\u0430\u0441 ISO", duration: "\u0442\u0440\u0438\u0432\u0430\u043B\u0456\u0441\u0442\u044C ISO", ipv4: "\u0430\u0434\u0440\u0435\u0441\u0430 IPv4", ipv6: "\u0430\u0434\u0440\u0435\u0441\u0430 IPv6", cidrv4: "\u0434\u0456\u0430\u043F\u0430\u0437\u043E\u043D IPv4", cidrv6: "\u0434\u0456\u0430\u043F\u0430\u0437\u043E\u043D IPv6", base64: "\u0440\u044F\u0434\u043E\u043A \u0443 \u043A\u043E\u0434\u0443\u0432\u0430\u043D\u043D\u0456 base64", base64url: "\u0440\u044F\u0434\u043E\u043A \u0443 \u043A\u043E\u0434\u0443\u0432\u0430\u043D\u043D\u0456 base64url", json_string: "\u0440\u044F\u0434\u043E\u043A JSON", e164: "\u043D\u043E\u043C\u0435\u0440 E.164", jwt: "JWT", template_literal: "\u0432\u0445\u0456\u0434\u043D\u0456 \u0434\u0430\u043D\u0456" };
  return (n) => {
    switch (n.code) {
      case "invalid_type":
        return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0456 \u0432\u0445\u0456\u0434\u043D\u0456 \u0434\u0430\u043D\u0456: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F ${n.expected}, \u043E\u0442\u0440\u0438\u043C\u0430\u043D\u043E ${r(n.input)}`;
      case "invalid_value":
        if (n.values.length === 1) return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0456 \u0432\u0445\u0456\u0434\u043D\u0456 \u0434\u0430\u043D\u0456: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F ${D(n.values[0])}`;
        return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0430 \u043E\u043F\u0446\u0456\u044F: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F \u043E\u0434\u043D\u0435 \u0437 ${P(n.values, "|")}`;
      case "too_big": {
        let i = n.inclusive ? "<=" : "<", s = t(n.origin);
        if (s) return `\u0417\u0430\u043D\u0430\u0434\u0442\u043E \u0432\u0435\u043B\u0438\u043A\u0435: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F, \u0449\u043E ${n.origin ?? "\u0437\u043D\u0430\u0447\u0435\u043D\u043D\u044F"} ${s.verb} ${i}${n.maximum.toString()} ${s.unit ?? "\u0435\u043B\u0435\u043C\u0435\u043D\u0442\u0456\u0432"}`;
        return `\u0417\u0430\u043D\u0430\u0434\u0442\u043E \u0432\u0435\u043B\u0438\u043A\u0435: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F, \u0449\u043E ${n.origin ?? "\u0437\u043D\u0430\u0447\u0435\u043D\u043D\u044F"} \u0431\u0443\u0434\u0435 ${i}${n.maximum.toString()}`;
      }
      case "too_small": {
        let i = n.inclusive ? ">=" : ">", s = t(n.origin);
        if (s) return `\u0417\u0430\u043D\u0430\u0434\u0442\u043E \u043C\u0430\u043B\u0435: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F, \u0449\u043E ${n.origin} ${s.verb} ${i}${n.minimum.toString()} ${s.unit}`;
        return `\u0417\u0430\u043D\u0430\u0434\u0442\u043E \u043C\u0430\u043B\u0435: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F, \u0449\u043E ${n.origin} \u0431\u0443\u0434\u0435 ${i}${n.minimum.toString()}`;
      }
      case "invalid_format": {
        let i = n;
        if (i.format === "starts_with") return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0438\u0439 \u0440\u044F\u0434\u043E\u043A: \u043F\u043E\u0432\u0438\u043D\u0435\u043D \u043F\u043E\u0447\u0438\u043D\u0430\u0442\u0438\u0441\u044F \u0437 "${i.prefix}"`;
        if (i.format === "ends_with") return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0438\u0439 \u0440\u044F\u0434\u043E\u043A: \u043F\u043E\u0432\u0438\u043D\u0435\u043D \u0437\u0430\u043A\u0456\u043D\u0447\u0443\u0432\u0430\u0442\u0438\u0441\u044F \u043D\u0430 "${i.suffix}"`;
        if (i.format === "includes") return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0438\u0439 \u0440\u044F\u0434\u043E\u043A: \u043F\u043E\u0432\u0438\u043D\u0435\u043D \u043C\u0456\u0441\u0442\u0438\u0442\u0438 "${i.includes}"`;
        if (i.format === "regex") return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0438\u0439 \u0440\u044F\u0434\u043E\u043A: \u043F\u043E\u0432\u0438\u043D\u0435\u043D \u0432\u0456\u0434\u043F\u043E\u0432\u0456\u0434\u0430\u0442\u0438 \u0448\u0430\u0431\u043B\u043E\u043D\u0443 ${i.pattern}`;
        return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0438\u0439 ${o[i.format] ?? n.format}`;
      }
      case "not_multiple_of":
        return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0435 \u0447\u0438\u0441\u043B\u043E: \u043F\u043E\u0432\u0438\u043D\u043D\u043E \u0431\u0443\u0442\u0438 \u043A\u0440\u0430\u0442\u043D\u0438\u043C ${n.divisor}`;
      case "unrecognized_keys":
        return `\u041D\u0435\u0440\u043E\u0437\u043F\u0456\u0437\u043D\u0430\u043D\u0438\u0439 \u043A\u043B\u044E\u0447${n.keys.length > 1 ? "\u0456" : ""}: ${P(n.keys, ", ")}`;
      case "invalid_key":
        return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0438\u0439 \u043A\u043B\u044E\u0447 \u0443 ${n.origin}`;
      case "invalid_union":
        return "\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0456 \u0432\u0445\u0456\u0434\u043D\u0456 \u0434\u0430\u043D\u0456";
      case "invalid_element":
        return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u043D\u044F \u0443 ${n.origin}`;
      default:
        return "\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0456 \u0432\u0445\u0456\u0434\u043D\u0456 \u0434\u0430\u043D\u0456";
    }
  };
};
function Z_() {
  return { localeError: _W() };
}
var vW = () => {
  let e = { string: { unit: "\u062D\u0631\u0648\u0641", verb: "\u06C1\u0648\u0646\u0627" }, file: { unit: "\u0628\u0627\u0626\u0679\u0633", verb: "\u06C1\u0648\u0646\u0627" }, array: { unit: "\u0622\u0626\u0679\u0645\u0632", verb: "\u06C1\u0648\u0646\u0627" }, set: { unit: "\u0622\u0626\u0679\u0645\u0632", verb: "\u06C1\u0648\u0646\u0627" } };
  function t(n) {
    return e[n] ?? null;
  }
  let r = (n) => {
    let i = typeof n;
    switch (i) {
      case "number":
        return Number.isNaN(n) ? "NaN" : "\u0646\u0645\u0628\u0631";
      case "object": {
        if (Array.isArray(n)) return "\u0622\u0631\u06D2";
        if (n === null) return "\u0646\u0644";
        if (Object.getPrototypeOf(n) !== Object.prototype && n.constructor) return n.constructor.name;
      }
    }
    return i;
  }, o = { regex: "\u0627\u0646 \u067E\u0679", email: "\u0627\u06CC \u0645\u06CC\u0644 \u0627\u06CC\u0688\u0631\u06CC\u0633", url: "\u06CC\u0648 \u0622\u0631 \u0627\u06CC\u0644", emoji: "\u0627\u06CC\u0645\u0648\u062C\u06CC", uuid: "\u06CC\u0648 \u06CC\u0648 \u0622\u0626\u06CC \u0688\u06CC", uuidv4: "\u06CC\u0648 \u06CC\u0648 \u0622\u0626\u06CC \u0688\u06CC \u0648\u06CC 4", uuidv6: "\u06CC\u0648 \u06CC\u0648 \u0622\u0626\u06CC \u0688\u06CC \u0648\u06CC 6", nanoid: "\u0646\u06CC\u0646\u0648 \u0622\u0626\u06CC \u0688\u06CC", guid: "\u062C\u06CC \u06CC\u0648 \u0622\u0626\u06CC \u0688\u06CC", cuid: "\u0633\u06CC \u06CC\u0648 \u0622\u0626\u06CC \u0688\u06CC", cuid2: "\u0633\u06CC \u06CC\u0648 \u0622\u0626\u06CC \u0688\u06CC 2", ulid: "\u06CC\u0648 \u0627\u06CC\u0644 \u0622\u0626\u06CC \u0688\u06CC", xid: "\u0627\u06CC\u06A9\u0633 \u0622\u0626\u06CC \u0688\u06CC", ksuid: "\u06A9\u06D2 \u0627\u06CC\u0633 \u06CC\u0648 \u0622\u0626\u06CC \u0688\u06CC", datetime: "\u0622\u0626\u06CC \u0627\u06CC\u0633 \u0627\u0648 \u0688\u06CC\u0679 \u0679\u0627\u0626\u0645", date: "\u0622\u0626\u06CC \u0627\u06CC\u0633 \u0627\u0648 \u062A\u0627\u0631\u06CC\u062E", time: "\u0622\u0626\u06CC \u0627\u06CC\u0633 \u0627\u0648 \u0648\u0642\u062A", duration: "\u0622\u0626\u06CC \u0627\u06CC\u0633 \u0627\u0648 \u0645\u062F\u062A", ipv4: "\u0622\u0626\u06CC \u067E\u06CC \u0648\u06CC 4 \u0627\u06CC\u0688\u0631\u06CC\u0633", ipv6: "\u0622\u0626\u06CC \u067E\u06CC \u0648\u06CC 6 \u0627\u06CC\u0688\u0631\u06CC\u0633", cidrv4: "\u0622\u0626\u06CC \u067E\u06CC \u0648\u06CC 4 \u0631\u06CC\u0646\u062C", cidrv6: "\u0622\u0626\u06CC \u067E\u06CC \u0648\u06CC 6 \u0631\u06CC\u0646\u062C", base64: "\u0628\u06CC\u0633 64 \u0627\u0646 \u06A9\u0648\u0688\u0688 \u0633\u0679\u0631\u0646\u06AF", base64url: "\u0628\u06CC\u0633 64 \u06CC\u0648 \u0622\u0631 \u0627\u06CC\u0644 \u0627\u0646 \u06A9\u0648\u0688\u0688 \u0633\u0679\u0631\u0646\u06AF", json_string: "\u062C\u06D2 \u0627\u06CC\u0633 \u0627\u0648 \u0627\u06CC\u0646 \u0633\u0679\u0631\u0646\u06AF", e164: "\u0627\u06CC 164 \u0646\u0645\u0628\u0631", jwt: "\u062C\u06D2 \u0688\u0628\u0644\u06CC\u0648 \u0679\u06CC", template_literal: "\u0627\u0646 \u067E\u0679" };
  return (n) => {
    switch (n.code) {
      case "invalid_type":
        return `\u063A\u0644\u0637 \u0627\u0646 \u067E\u0679: ${n.expected} \u0645\u062A\u0648\u0642\u0639 \u062A\u06BE\u0627\u060C ${r(n.input)} \u0645\u0648\u0635\u0648\u0644 \u06C1\u0648\u0627`;
      case "invalid_value":
        if (n.values.length === 1) return `\u063A\u0644\u0637 \u0627\u0646 \u067E\u0679: ${D(n.values[0])} \u0645\u062A\u0648\u0642\u0639 \u062A\u06BE\u0627`;
        return `\u063A\u0644\u0637 \u0622\u067E\u0634\u0646: ${P(n.values, "|")} \u0645\u06CC\u06BA \u0633\u06D2 \u0627\u06CC\u06A9 \u0645\u062A\u0648\u0642\u0639 \u062A\u06BE\u0627`;
      case "too_big": {
        let i = n.inclusive ? "<=" : "<", s = t(n.origin);
        if (s) return `\u0628\u06C1\u062A \u0628\u0691\u0627: ${n.origin ?? "\u0648\u06CC\u0644\u06CC\u0648"} \u06A9\u06D2 ${i}${n.maximum.toString()} ${s.unit ?? "\u0639\u0646\u0627\u0635\u0631"} \u06C1\u0648\u0646\u06D2 \u0645\u062A\u0648\u0642\u0639 \u062A\u06BE\u06D2`;
        return `\u0628\u06C1\u062A \u0628\u0691\u0627: ${n.origin ?? "\u0648\u06CC\u0644\u06CC\u0648"} \u06A9\u0627 ${i}${n.maximum.toString()} \u06C1\u0648\u0646\u0627 \u0645\u062A\u0648\u0642\u0639 \u062A\u06BE\u0627`;
      }
      case "too_small": {
        let i = n.inclusive ? ">=" : ">", s = t(n.origin);
        if (s) return `\u0628\u06C1\u062A \u0686\u06BE\u0648\u0679\u0627: ${n.origin} \u06A9\u06D2 ${i}${n.minimum.toString()} ${s.unit} \u06C1\u0648\u0646\u06D2 \u0645\u062A\u0648\u0642\u0639 \u062A\u06BE\u06D2`;
        return `\u0628\u06C1\u062A \u0686\u06BE\u0648\u0679\u0627: ${n.origin} \u06A9\u0627 ${i}${n.minimum.toString()} \u06C1\u0648\u0646\u0627 \u0645\u062A\u0648\u0642\u0639 \u062A\u06BE\u0627`;
      }
      case "invalid_format": {
        let i = n;
        if (i.format === "starts_with") return `\u063A\u0644\u0637 \u0633\u0679\u0631\u0646\u06AF: "${i.prefix}" \u0633\u06D2 \u0634\u0631\u0648\u0639 \u06C1\u0648\u0646\u0627 \u0686\u0627\u06C1\u06CC\u06D2`;
        if (i.format === "ends_with") return `\u063A\u0644\u0637 \u0633\u0679\u0631\u0646\u06AF: "${i.suffix}" \u067E\u0631 \u062E\u062A\u0645 \u06C1\u0648\u0646\u0627 \u0686\u0627\u06C1\u06CC\u06D2`;
        if (i.format === "includes") return `\u063A\u0644\u0637 \u0633\u0679\u0631\u0646\u06AF: "${i.includes}" \u0634\u0627\u0645\u0644 \u06C1\u0648\u0646\u0627 \u0686\u0627\u06C1\u06CC\u06D2`;
        if (i.format === "regex") return `\u063A\u0644\u0637 \u0633\u0679\u0631\u0646\u06AF: \u067E\u06CC\u0679\u0631\u0646 ${i.pattern} \u0633\u06D2 \u0645\u06CC\u0686 \u06C1\u0648\u0646\u0627 \u0686\u0627\u06C1\u06CC\u06D2`;
        return `\u063A\u0644\u0637 ${o[i.format] ?? n.format}`;
      }
      case "not_multiple_of":
        return `\u063A\u0644\u0637 \u0646\u0645\u0628\u0631: ${n.divisor} \u06A9\u0627 \u0645\u0636\u0627\u0639\u0641 \u06C1\u0648\u0646\u0627 \u0686\u0627\u06C1\u06CC\u06D2`;
      case "unrecognized_keys":
        return `\u063A\u06CC\u0631 \u062A\u0633\u0644\u06CC\u0645 \u0634\u062F\u06C1 \u06A9\u06CC${n.keys.length > 1 ? "\u0632" : ""}: ${P(n.keys, "\u060C ")}`;
      case "invalid_key":
        return `${n.origin} \u0645\u06CC\u06BA \u063A\u0644\u0637 \u06A9\u06CC`;
      case "invalid_union":
        return "\u063A\u0644\u0637 \u0627\u0646 \u067E\u0679";
      case "invalid_element":
        return `${n.origin} \u0645\u06CC\u06BA \u063A\u0644\u0637 \u0648\u06CC\u0644\u06CC\u0648`;
      default:
        return "\u063A\u0644\u0637 \u0627\u0646 \u067E\u0679";
    }
  };
};
function W_() {
  return { localeError: vW() };
}
var SW = () => {
  let e = { string: { unit: "k\xFD t\u1EF1", verb: "c\xF3" }, file: { unit: "byte", verb: "c\xF3" }, array: { unit: "ph\u1EA7n t\u1EED", verb: "c\xF3" }, set: { unit: "ph\u1EA7n t\u1EED", verb: "c\xF3" } };
  function t(n) {
    return e[n] ?? null;
  }
  let r = (n) => {
    let i = typeof n;
    switch (i) {
      case "number":
        return Number.isNaN(n) ? "NaN" : "s\u1ED1";
      case "object": {
        if (Array.isArray(n)) return "m\u1EA3ng";
        if (n === null) return "null";
        if (Object.getPrototypeOf(n) !== Object.prototype && n.constructor) return n.constructor.name;
      }
    }
    return i;
  }, o = { regex: "\u0111\u1EA7u v\xE0o", email: "\u0111\u1ECBa ch\u1EC9 email", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ng\xE0y gi\u1EDD ISO", date: "ng\xE0y ISO", time: "gi\u1EDD ISO", duration: "kho\u1EA3ng th\u1EDDi gian ISO", ipv4: "\u0111\u1ECBa ch\u1EC9 IPv4", ipv6: "\u0111\u1ECBa ch\u1EC9 IPv6", cidrv4: "d\u1EA3i IPv4", cidrv6: "d\u1EA3i IPv6", base64: "chu\u1ED7i m\xE3 h\xF3a base64", base64url: "chu\u1ED7i m\xE3 h\xF3a base64url", json_string: "chu\u1ED7i JSON", e164: "s\u1ED1 E.164", jwt: "JWT", template_literal: "\u0111\u1EA7u v\xE0o" };
  return (n) => {
    switch (n.code) {
      case "invalid_type":
        return `\u0110\u1EA7u v\xE0o kh\xF4ng h\u1EE3p l\u1EC7: mong \u0111\u1EE3i ${n.expected}, nh\u1EADn \u0111\u01B0\u1EE3c ${r(n.input)}`;
      case "invalid_value":
        if (n.values.length === 1) return `\u0110\u1EA7u v\xE0o kh\xF4ng h\u1EE3p l\u1EC7: mong \u0111\u1EE3i ${D(n.values[0])}`;
        return `T\xF9y ch\u1ECDn kh\xF4ng h\u1EE3p l\u1EC7: mong \u0111\u1EE3i m\u1ED9t trong c\xE1c gi\xE1 tr\u1ECB ${P(n.values, "|")}`;
      case "too_big": {
        let i = n.inclusive ? "<=" : "<", s = t(n.origin);
        if (s) return `Qu\xE1 l\u1EDBn: mong \u0111\u1EE3i ${n.origin ?? "gi\xE1 tr\u1ECB"} ${s.verb} ${i}${n.maximum.toString()} ${s.unit ?? "ph\u1EA7n t\u1EED"}`;
        return `Qu\xE1 l\u1EDBn: mong \u0111\u1EE3i ${n.origin ?? "gi\xE1 tr\u1ECB"} ${i}${n.maximum.toString()}`;
      }
      case "too_small": {
        let i = n.inclusive ? ">=" : ">", s = t(n.origin);
        if (s) return `Qu\xE1 nh\u1ECF: mong \u0111\u1EE3i ${n.origin} ${s.verb} ${i}${n.minimum.toString()} ${s.unit}`;
        return `Qu\xE1 nh\u1ECF: mong \u0111\u1EE3i ${n.origin} ${i}${n.minimum.toString()}`;
      }
      case "invalid_format": {
        let i = n;
        if (i.format === "starts_with") return `Chu\u1ED7i kh\xF4ng h\u1EE3p l\u1EC7: ph\u1EA3i b\u1EAFt \u0111\u1EA7u b\u1EB1ng "${i.prefix}"`;
        if (i.format === "ends_with") return `Chu\u1ED7i kh\xF4ng h\u1EE3p l\u1EC7: ph\u1EA3i k\u1EBFt th\xFAc b\u1EB1ng "${i.suffix}"`;
        if (i.format === "includes") return `Chu\u1ED7i kh\xF4ng h\u1EE3p l\u1EC7: ph\u1EA3i bao g\u1ED3m "${i.includes}"`;
        if (i.format === "regex") return `Chu\u1ED7i kh\xF4ng h\u1EE3p l\u1EC7: ph\u1EA3i kh\u1EDBp v\u1EDBi m\u1EABu ${i.pattern}`;
        return `${o[i.format] ?? n.format} kh\xF4ng h\u1EE3p l\u1EC7`;
      }
      case "not_multiple_of":
        return `S\u1ED1 kh\xF4ng h\u1EE3p l\u1EC7: ph\u1EA3i l\xE0 b\u1ED9i s\u1ED1 c\u1EE7a ${n.divisor}`;
      case "unrecognized_keys":
        return `Kh\xF3a kh\xF4ng \u0111\u01B0\u1EE3c nh\u1EADn d\u1EA1ng: ${P(n.keys, ", ")}`;
      case "invalid_key":
        return `Kh\xF3a kh\xF4ng h\u1EE3p l\u1EC7 trong ${n.origin}`;
      case "invalid_union":
        return "\u0110\u1EA7u v\xE0o kh\xF4ng h\u1EE3p l\u1EC7";
      case "invalid_element":
        return `Gi\xE1 tr\u1ECB kh\xF4ng h\u1EE3p l\u1EC7 trong ${n.origin}`;
      default:
        return "\u0110\u1EA7u v\xE0o kh\xF4ng h\u1EE3p l\u1EC7";
    }
  };
};
function K_() {
  return { localeError: SW() };
}
var xW = () => {
  let e = { string: { unit: "\u5B57\u7B26", verb: "\u5305\u542B" }, file: { unit: "\u5B57\u8282", verb: "\u5305\u542B" }, array: { unit: "\u9879", verb: "\u5305\u542B" }, set: { unit: "\u9879", verb: "\u5305\u542B" } };
  function t(n) {
    return e[n] ?? null;
  }
  let r = (n) => {
    let i = typeof n;
    switch (i) {
      case "number":
        return Number.isNaN(n) ? "\u975E\u6570\u5B57(NaN)" : "\u6570\u5B57";
      case "object": {
        if (Array.isArray(n)) return "\u6570\u7EC4";
        if (n === null) return "\u7A7A\u503C(null)";
        if (Object.getPrototypeOf(n) !== Object.prototype && n.constructor) return n.constructor.name;
      }
    }
    return i;
  }, o = { regex: "\u8F93\u5165", email: "\u7535\u5B50\u90AE\u4EF6", url: "URL", emoji: "\u8868\u60C5\u7B26\u53F7", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO\u65E5\u671F\u65F6\u95F4", date: "ISO\u65E5\u671F", time: "ISO\u65F6\u95F4", duration: "ISO\u65F6\u957F", ipv4: "IPv4\u5730\u5740", ipv6: "IPv6\u5730\u5740", cidrv4: "IPv4\u7F51\u6BB5", cidrv6: "IPv6\u7F51\u6BB5", base64: "base64\u7F16\u7801\u5B57\u7B26\u4E32", base64url: "base64url\u7F16\u7801\u5B57\u7B26\u4E32", json_string: "JSON\u5B57\u7B26\u4E32", e164: "E.164\u53F7\u7801", jwt: "JWT", template_literal: "\u8F93\u5165" };
  return (n) => {
    switch (n.code) {
      case "invalid_type":
        return `\u65E0\u6548\u8F93\u5165\uFF1A\u671F\u671B ${n.expected}\uFF0C\u5B9E\u9645\u63A5\u6536 ${r(n.input)}`;
      case "invalid_value":
        if (n.values.length === 1) return `\u65E0\u6548\u8F93\u5165\uFF1A\u671F\u671B ${D(n.values[0])}`;
        return `\u65E0\u6548\u9009\u9879\uFF1A\u671F\u671B\u4EE5\u4E0B\u4E4B\u4E00 ${P(n.values, "|")}`;
      case "too_big": {
        let i = n.inclusive ? "<=" : "<", s = t(n.origin);
        if (s) return `\u6570\u503C\u8FC7\u5927\uFF1A\u671F\u671B ${n.origin ?? "\u503C"} ${i}${n.maximum.toString()} ${s.unit ?? "\u4E2A\u5143\u7D20"}`;
        return `\u6570\u503C\u8FC7\u5927\uFF1A\u671F\u671B ${n.origin ?? "\u503C"} ${i}${n.maximum.toString()}`;
      }
      case "too_small": {
        let i = n.inclusive ? ">=" : ">", s = t(n.origin);
        if (s) return `\u6570\u503C\u8FC7\u5C0F\uFF1A\u671F\u671B ${n.origin} ${i}${n.minimum.toString()} ${s.unit}`;
        return `\u6570\u503C\u8FC7\u5C0F\uFF1A\u671F\u671B ${n.origin} ${i}${n.minimum.toString()}`;
      }
      case "invalid_format": {
        let i = n;
        if (i.format === "starts_with") return `\u65E0\u6548\u5B57\u7B26\u4E32\uFF1A\u5FC5\u987B\u4EE5 "${i.prefix}" \u5F00\u5934`;
        if (i.format === "ends_with") return `\u65E0\u6548\u5B57\u7B26\u4E32\uFF1A\u5FC5\u987B\u4EE5 "${i.suffix}" \u7ED3\u5C3E`;
        if (i.format === "includes") return `\u65E0\u6548\u5B57\u7B26\u4E32\uFF1A\u5FC5\u987B\u5305\u542B "${i.includes}"`;
        if (i.format === "regex") return `\u65E0\u6548\u5B57\u7B26\u4E32\uFF1A\u5FC5\u987B\u6EE1\u8DB3\u6B63\u5219\u8868\u8FBE\u5F0F ${i.pattern}`;
        return `\u65E0\u6548${o[i.format] ?? n.format}`;
      }
      case "not_multiple_of":
        return `\u65E0\u6548\u6570\u5B57\uFF1A\u5FC5\u987B\u662F ${n.divisor} \u7684\u500D\u6570`;
      case "unrecognized_keys":
        return `\u51FA\u73B0\u672A\u77E5\u7684\u952E(key): ${P(n.keys, ", ")}`;
      case "invalid_key":
        return `${n.origin} \u4E2D\u7684\u952E(key)\u65E0\u6548`;
      case "invalid_union":
        return "\u65E0\u6548\u8F93\u5165";
      case "invalid_element":
        return `${n.origin} \u4E2D\u5305\u542B\u65E0\u6548\u503C(value)`;
      default:
        return "\u65E0\u6548\u8F93\u5165";
    }
  };
};
function G_() {
  return { localeError: xW() };
}
var wW = () => {
  let e = { string: { unit: "\u5B57\u5143", verb: "\u64C1\u6709" }, file: { unit: "\u4F4D\u5143\u7D44", verb: "\u64C1\u6709" }, array: { unit: "\u9805\u76EE", verb: "\u64C1\u6709" }, set: { unit: "\u9805\u76EE", verb: "\u64C1\u6709" } };
  function t(n) {
    return e[n] ?? null;
  }
  let r = (n) => {
    let i = typeof n;
    switch (i) {
      case "number":
        return Number.isNaN(n) ? "NaN" : "number";
      case "object": {
        if (Array.isArray(n)) return "array";
        if (n === null) return "null";
        if (Object.getPrototypeOf(n) !== Object.prototype && n.constructor) return n.constructor.name;
      }
    }
    return i;
  }, o = { regex: "\u8F38\u5165", email: "\u90F5\u4EF6\u5730\u5740", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO \u65E5\u671F\u6642\u9593", date: "ISO \u65E5\u671F", time: "ISO \u6642\u9593", duration: "ISO \u671F\u9593", ipv4: "IPv4 \u4F4D\u5740", ipv6: "IPv6 \u4F4D\u5740", cidrv4: "IPv4 \u7BC4\u570D", cidrv6: "IPv6 \u7BC4\u570D", base64: "base64 \u7DE8\u78BC\u5B57\u4E32", base64url: "base64url \u7DE8\u78BC\u5B57\u4E32", json_string: "JSON \u5B57\u4E32", e164: "E.164 \u6578\u503C", jwt: "JWT", template_literal: "\u8F38\u5165" };
  return (n) => {
    switch (n.code) {
      case "invalid_type":
        return `\u7121\u6548\u7684\u8F38\u5165\u503C\uFF1A\u9810\u671F\u70BA ${n.expected}\uFF0C\u4F46\u6536\u5230 ${r(n.input)}`;
      case "invalid_value":
        if (n.values.length === 1) return `\u7121\u6548\u7684\u8F38\u5165\u503C\uFF1A\u9810\u671F\u70BA ${D(n.values[0])}`;
        return `\u7121\u6548\u7684\u9078\u9805\uFF1A\u9810\u671F\u70BA\u4EE5\u4E0B\u5176\u4E2D\u4E4B\u4E00 ${P(n.values, "|")}`;
      case "too_big": {
        let i = n.inclusive ? "<=" : "<", s = t(n.origin);
        if (s) return `\u6578\u503C\u904E\u5927\uFF1A\u9810\u671F ${n.origin ?? "\u503C"} \u61C9\u70BA ${i}${n.maximum.toString()} ${s.unit ?? "\u500B\u5143\u7D20"}`;
        return `\u6578\u503C\u904E\u5927\uFF1A\u9810\u671F ${n.origin ?? "\u503C"} \u61C9\u70BA ${i}${n.maximum.toString()}`;
      }
      case "too_small": {
        let i = n.inclusive ? ">=" : ">", s = t(n.origin);
        if (s) return `\u6578\u503C\u904E\u5C0F\uFF1A\u9810\u671F ${n.origin} \u61C9\u70BA ${i}${n.minimum.toString()} ${s.unit}`;
        return `\u6578\u503C\u904E\u5C0F\uFF1A\u9810\u671F ${n.origin} \u61C9\u70BA ${i}${n.minimum.toString()}`;
      }
      case "invalid_format": {
        let i = n;
        if (i.format === "starts_with") return `\u7121\u6548\u7684\u5B57\u4E32\uFF1A\u5FC5\u9808\u4EE5 "${i.prefix}" \u958B\u982D`;
        if (i.format === "ends_with") return `\u7121\u6548\u7684\u5B57\u4E32\uFF1A\u5FC5\u9808\u4EE5 "${i.suffix}" \u7D50\u5C3E`;
        if (i.format === "includes") return `\u7121\u6548\u7684\u5B57\u4E32\uFF1A\u5FC5\u9808\u5305\u542B "${i.includes}"`;
        if (i.format === "regex") return `\u7121\u6548\u7684\u5B57\u4E32\uFF1A\u5FC5\u9808\u7B26\u5408\u683C\u5F0F ${i.pattern}`;
        return `\u7121\u6548\u7684 ${o[i.format] ?? n.format}`;
      }
      case "not_multiple_of":
        return `\u7121\u6548\u7684\u6578\u5B57\uFF1A\u5FC5\u9808\u70BA ${n.divisor} \u7684\u500D\u6578`;
      case "unrecognized_keys":
        return `\u7121\u6CD5\u8B58\u5225\u7684\u9375\u503C${n.keys.length > 1 ? "\u5011" : ""}\uFF1A${P(n.keys, "\u3001")}`;
      case "invalid_key":
        return `${n.origin} \u4E2D\u6709\u7121\u6548\u7684\u9375\u503C`;
      case "invalid_union":
        return "\u7121\u6548\u7684\u8F38\u5165\u503C";
      case "invalid_element":
        return `${n.origin} \u4E2D\u6709\u7121\u6548\u7684\u503C`;
      default:
        return "\u7121\u6548\u7684\u8F38\u5165\u503C";
    }
  };
};
function J_() {
  return { localeError: wW() };
}
var cf = Symbol("ZodOutput");
var lf = Symbol("ZodInput");
var jc = class {
  constructor() {
    this._map = /* @__PURE__ */ new WeakMap(), this._idmap = /* @__PURE__ */ new Map();
  }
  add(e, ...t) {
    let r = t[0];
    if (this._map.set(e, r), r && typeof r === "object" && "id" in r) {
      if (this._idmap.has(r.id)) throw Error(`ID ${r.id} already exists in the registry`);
      this._idmap.set(r.id, e);
    }
    return this;
  }
  remove(e) {
    return this._map.delete(e), this;
  }
  get(e) {
    let t = e._zod.parent;
    if (t) {
      let r = { ...this.get(t) ?? {} };
      return delete r.id, { ...r, ...this._map.get(e) };
    }
    return this._map.get(e);
  }
  has(e) {
    return this._map.has(e);
  }
};
function Uc() {
  return new jc();
}
var Et = Uc();
function uf(e, t) {
  return new e({ type: "string", ...A(t) });
}
function X_(e, t) {
  return new e({ type: "string", coerce: true, ...A(t) });
}
function zc(e, t) {
  return new e({ type: "string", format: "email", check: "string_format", abort: false, ...A(t) });
}
function is(e, t) {
  return new e({ type: "string", format: "guid", check: "string_format", abort: false, ...A(t) });
}
function Lc(e, t) {
  return new e({ type: "string", format: "uuid", check: "string_format", abort: false, ...A(t) });
}
function Fc(e, t) {
  return new e({ type: "string", format: "uuid", check: "string_format", abort: false, version: "v4", ...A(t) });
}
function Hc(e, t) {
  return new e({ type: "string", format: "uuid", check: "string_format", abort: false, version: "v6", ...A(t) });
}
function Bc(e, t) {
  return new e({ type: "string", format: "uuid", check: "string_format", abort: false, version: "v7", ...A(t) });
}
function qc(e, t) {
  return new e({ type: "string", format: "url", check: "string_format", abort: false, ...A(t) });
}
function Vc(e, t) {
  return new e({ type: "string", format: "emoji", check: "string_format", abort: false, ...A(t) });
}
function Zc(e, t) {
  return new e({ type: "string", format: "nanoid", check: "string_format", abort: false, ...A(t) });
}
function Wc(e, t) {
  return new e({ type: "string", format: "cuid", check: "string_format", abort: false, ...A(t) });
}
function Kc(e, t) {
  return new e({ type: "string", format: "cuid2", check: "string_format", abort: false, ...A(t) });
}
function Gc(e, t) {
  return new e({ type: "string", format: "ulid", check: "string_format", abort: false, ...A(t) });
}
function Jc(e, t) {
  return new e({ type: "string", format: "xid", check: "string_format", abort: false, ...A(t) });
}
function Xc(e, t) {
  return new e({ type: "string", format: "ksuid", check: "string_format", abort: false, ...A(t) });
}
function Yc(e, t) {
  return new e({ type: "string", format: "ipv4", check: "string_format", abort: false, ...A(t) });
}
function Qc(e, t) {
  return new e({ type: "string", format: "ipv6", check: "string_format", abort: false, ...A(t) });
}
function el(e, t) {
  return new e({ type: "string", format: "cidrv4", check: "string_format", abort: false, ...A(t) });
}
function tl(e, t) {
  return new e({ type: "string", format: "cidrv6", check: "string_format", abort: false, ...A(t) });
}
function rl(e, t) {
  return new e({ type: "string", format: "base64", check: "string_format", abort: false, ...A(t) });
}
function nl(e, t) {
  return new e({ type: "string", format: "base64url", check: "string_format", abort: false, ...A(t) });
}
function ol(e, t) {
  return new e({ type: "string", format: "e164", check: "string_format", abort: false, ...A(t) });
}
function il(e, t) {
  return new e({ type: "string", format: "jwt", check: "string_format", abort: false, ...A(t) });
}
var df = { Any: null, Minute: -1, Second: 0, Millisecond: 3, Microsecond: 6 };
function Y_(e, t) {
  return new e({ type: "string", format: "datetime", check: "string_format", offset: false, local: false, precision: null, ...A(t) });
}
function Q_(e, t) {
  return new e({ type: "string", format: "date", check: "string_format", ...A(t) });
}
function ev(e, t) {
  return new e({ type: "string", format: "time", check: "string_format", precision: null, ...A(t) });
}
function tv(e, t) {
  return new e({ type: "string", format: "duration", check: "string_format", ...A(t) });
}
function pf(e, t) {
  return new e({ type: "number", checks: [], ...A(t) });
}
function rv(e, t) {
  return new e({ type: "number", coerce: true, checks: [], ...A(t) });
}
function ff(e, t) {
  return new e({ type: "number", check: "number_format", abort: false, format: "safeint", ...A(t) });
}
function mf(e, t) {
  return new e({ type: "number", check: "number_format", abort: false, format: "float32", ...A(t) });
}
function gf(e, t) {
  return new e({ type: "number", check: "number_format", abort: false, format: "float64", ...A(t) });
}
function hf(e, t) {
  return new e({ type: "number", check: "number_format", abort: false, format: "int32", ...A(t) });
}
function yf(e, t) {
  return new e({ type: "number", check: "number_format", abort: false, format: "uint32", ...A(t) });
}
function bf(e, t) {
  return new e({ type: "boolean", ...A(t) });
}
function nv(e, t) {
  return new e({ type: "boolean", coerce: true, ...A(t) });
}
function _f(e, t) {
  return new e({ type: "bigint", ...A(t) });
}
function ov(e, t) {
  return new e({ type: "bigint", coerce: true, ...A(t) });
}
function vf(e, t) {
  return new e({ type: "bigint", check: "bigint_format", abort: false, format: "int64", ...A(t) });
}
function Sf(e, t) {
  return new e({ type: "bigint", check: "bigint_format", abort: false, format: "uint64", ...A(t) });
}
function xf(e, t) {
  return new e({ type: "symbol", ...A(t) });
}
function wf(e, t) {
  return new e({ type: "undefined", ...A(t) });
}
function kf(e, t) {
  return new e({ type: "null", ...A(t) });
}
function Ef(e) {
  return new e({ type: "any" });
}
function Co(e) {
  return new e({ type: "unknown" });
}
function Pf(e, t) {
  return new e({ type: "never", ...A(t) });
}
function Tf(e, t) {
  return new e({ type: "void", ...A(t) });
}
function If(e, t) {
  return new e({ type: "date", ...A(t) });
}
function iv(e, t) {
  return new e({ type: "date", coerce: true, ...A(t) });
}
function Rf(e, t) {
  return new e({ type: "nan", ...A(t) });
}
function Yr(e, t) {
  return new sp({ check: "less_than", ...A(t), value: e, inclusive: false });
}
function Yt(e, t) {
  return new sp({ check: "less_than", ...A(t), value: e, inclusive: true });
}
function Qr(e, t) {
  return new ap({ check: "greater_than", ...A(t), value: e, inclusive: false });
}
function Pt(e, t) {
  return new ap({ check: "greater_than", ...A(t), value: e, inclusive: true });
}
function sv(e) {
  return Qr(0, e);
}
function av(e) {
  return Yr(0, e);
}
function cv(e) {
  return Yt(0, e);
}
function lv(e) {
  return Pt(0, e);
}
function Mo(e, t) {
  return new Hb({ check: "multiple_of", ...A(t), value: e });
}
function ss(e, t) {
  return new Vb({ check: "max_size", ...A(t), maximum: e });
}
function Do(e, t) {
  return new Zb({ check: "min_size", ...A(t), minimum: e });
}
function sl(e, t) {
  return new Wb({ check: "size_equals", ...A(t), size: e });
}
function as(e, t) {
  return new Kb({ check: "max_length", ...A(t), maximum: e });
}
function Dn(e, t) {
  return new Gb({ check: "min_length", ...A(t), minimum: e });
}
function cs(e, t) {
  return new Jb({ check: "length_equals", ...A(t), length: e });
}
function al(e, t) {
  return new Xb({ check: "string_format", format: "regex", ...A(t), pattern: e });
}
function cl(e) {
  return new Yb({ check: "string_format", format: "lowercase", ...A(e) });
}
function ll(e) {
  return new Qb({ check: "string_format", format: "uppercase", ...A(e) });
}
function ul(e, t) {
  return new e_({ check: "string_format", format: "includes", ...A(t), includes: e });
}
function dl(e, t) {
  return new t_({ check: "string_format", format: "starts_with", ...A(t), prefix: e });
}
function pl(e, t) {
  return new r_({ check: "string_format", format: "ends_with", ...A(t), suffix: e });
}
function uv(e, t, r) {
  return new n_({ check: "property", property: e, schema: t, ...A(r) });
}
function fl(e, t) {
  return new o_({ check: "mime_type", mime: e, ...A(t) });
}
function en(e) {
  return new i_({ check: "overwrite", tx: e });
}
function ml(e) {
  return en((t) => t.normalize(e));
}
function gl() {
  return en((e) => e.trim());
}
function hl() {
  return en((e) => e.toLowerCase());
}
function yl() {
  return en((e) => e.toUpperCase());
}
function bl(e, t, r) {
  return new e({ type: "array", element: t, ...A(r) });
}
function kW(e, t, r) {
  return new e({ type: "union", options: t, ...A(r) });
}
function EW(e, t, r, o) {
  return new e({ type: "union", options: r, discriminator: t, ...A(o) });
}
function PW(e, t, r) {
  return new e({ type: "intersection", left: t, right: r });
}
function dv(e, t, r, o) {
  let n = r instanceof G;
  return new e({ type: "tuple", items: t, rest: n ? r : null, ...A(n ? o : r) });
}
function TW(e, t, r, o) {
  return new e({ type: "record", keyType: t, valueType: r, ...A(o) });
}
function IW(e, t, r, o) {
  return new e({ type: "map", keyType: t, valueType: r, ...A(o) });
}
function RW(e, t, r) {
  return new e({ type: "set", valueType: t, ...A(r) });
}
function $W(e, t, r) {
  let o = Array.isArray(t) ? Object.fromEntries(t.map((n) => [n, n])) : t;
  return new e({ type: "enum", entries: o, ...A(r) });
}
function AW(e, t, r) {
  return new e({ type: "enum", entries: t, ...A(r) });
}
function OW(e, t, r) {
  return new e({ type: "literal", values: Array.isArray(t) ? t : [t], ...A(r) });
}
function $f(e, t) {
  return new e({ type: "file", ...A(t) });
}
function CW(e, t) {
  return new e({ type: "transform", transform: t });
}
function MW(e, t) {
  return new e({ type: "optional", innerType: t });
}
function DW(e, t) {
  return new e({ type: "nullable", innerType: t });
}
function NW(e, t, r) {
  return new e({ type: "default", innerType: t, get defaultValue() {
    return typeof r === "function" ? r() : r;
  } });
}
function jW(e, t, r) {
  return new e({ type: "nonoptional", innerType: t, ...A(r) });
}
function UW(e, t) {
  return new e({ type: "success", innerType: t });
}
function zW(e, t, r) {
  return new e({ type: "catch", innerType: t, catchValue: typeof r === "function" ? r : () => r });
}
function LW(e, t, r) {
  return new e({ type: "pipe", in: t, out: r });
}
function FW(e, t) {
  return new e({ type: "readonly", innerType: t });
}
function HW(e, t, r) {
  return new e({ type: "template_literal", parts: t, ...A(r) });
}
function BW(e, t) {
  return new e({ type: "lazy", getter: t });
}
function qW(e, t) {
  return new e({ type: "promise", innerType: t });
}
function Af(e, t, r) {
  let o = A(r);
  return o.abort ?? (o.abort = true), new e({ type: "custom", check: "custom", fn: t, ...o });
}
function Of(e, t, r) {
  return new e({ type: "custom", check: "custom", fn: t, ...A(r) });
}
function Cf(e, t) {
  let r = A(t), o = r.truthy ?? ["true", "1", "yes", "on", "y", "enabled"], n = r.falsy ?? ["false", "0", "no", "off", "n", "disabled"];
  if (r.case !== "sensitive") o = o.map((g) => typeof g === "string" ? g.toLowerCase() : g), n = n.map((g) => typeof g === "string" ? g.toLowerCase() : g);
  let i = new Set(o), s = new Set(n), a = e.Pipe ?? ns, c = e.Boolean ?? es, u = e.String ?? Cn, p = new (e.Transform ?? rs)({ type: "transform", transform: (g, h) => {
    let y = g;
    if (r.case !== "sensitive") y = y.toLowerCase();
    if (i.has(y)) return true;
    else if (s.has(y)) return false;
    else return h.issues.push({ code: "invalid_value", expected: "stringbool", values: [...i, ...s], input: h.value, inst: p }), {};
  }, error: r.error }), f = new a({ type: "pipe", in: new u({ type: "string", error: r.error }), out: p, error: r.error });
  return new a({ type: "pipe", in: f, out: new c({ type: "boolean", error: r.error }), error: r.error });
}
function Mf(e, t, r, o = {}) {
  let n = A(o), i = { ...A(o), check: "string_format", type: "string", format: t, fn: typeof r === "function" ? r : (a) => r.test(a), ...n };
  if (r instanceof RegExp) i.pattern = r;
  return new e(i);
}
var pv = class {
  constructor(e) {
    this._def = e, this.def = e;
  }
  implement(e) {
    if (typeof e !== "function") throw Error("implement() must be called with a function");
    let t = (...r) => {
      let o = this._def.input ? Ro(this._def.input, r, void 0, { callee: t }) : r;
      if (!Array.isArray(o)) throw Error("Invalid arguments schema: not an array or tuple schema.");
      let n = e(...o);
      return this._def.output ? Ro(this._def.output, n, void 0, { callee: t }) : n;
    };
    return t;
  }
  implementAsync(e) {
    if (typeof e !== "function") throw Error("implement() must be called with a function");
    let t = async (...r) => {
      let o = this._def.input ? await $o(this._def.input, r, void 0, { callee: t }) : r;
      if (!Array.isArray(o)) throw Error("Invalid arguments schema: not an array or tuple schema.");
      let n = await e(...o);
      return this._def.output ? $o(this._def.output, n, void 0, { callee: t }) : n;
    };
    return t;
  }
  input(...e) {
    let t = this.constructor;
    if (Array.isArray(e[0])) return new t({ type: "function", input: new Mn({ type: "tuple", items: e[0], rest: e[1] }), output: this._def.output });
    return new t({ type: "function", input: e[0], output: this._def.output });
  }
  output(e) {
    return new this.constructor({ type: "function", input: this._def.input, output: e });
  }
};
function Df(e) {
  return new pv({ type: "function", input: Array.isArray(e?.input) ? dv(Mn, e?.input) : e?.input ?? bl(ts, Co(Oo)), output: e?.output ?? Co(Oo) });
}
var Nf = class {
  constructor(e) {
    this.counter = 0, this.metadataRegistry = e?.metadata ?? Et, this.target = e?.target ?? "draft-2020-12", this.unrepresentable = e?.unrepresentable ?? "throw", this.override = e?.override ?? (() => {
    }), this.io = e?.io ?? "output", this.seen = /* @__PURE__ */ new Map();
  }
  process(e, t = { path: [], schemaPath: [] }) {
    var r;
    let o = e._zod.def, n = { guid: "uuid", url: "uri", datetime: "date-time", json_string: "json-string", regex: "" }, i = this.seen.get(e);
    if (i) {
      if (i.count++, t.schemaPath.includes(e)) i.cycle = t.path;
      return i.schema;
    }
    let s = { schema: {}, count: 1, cycle: void 0, path: t.path };
    this.seen.set(e, s);
    let a = e._zod.toJSONSchema?.();
    if (a) s.schema = a;
    else {
      let d = { ...t, schemaPath: [...t.schemaPath, e], path: t.path }, p = e._zod.parent;
      if (p) s.ref = p, this.process(p, d), this.seen.get(p).isParent = true;
      else {
        let f = s.schema;
        switch (o.type) {
          case "string": {
            let m = f;
            m.type = "string";
            let { minimum: g, maximum: h, format: y, patterns: v, contentEncoding: w } = e._zod.bag;
            if (typeof g === "number") m.minLength = g;
            if (typeof h === "number") m.maxLength = h;
            if (y) {
              if (m.format = n[y] ?? y, m.format === "") delete m.format;
            }
            if (w) m.contentEncoding = w;
            if (v && v.size > 0) {
              let x = [...v];
              if (x.length === 1) m.pattern = x[0].source;
              else if (x.length > 1) s.schema.allOf = [...x.map(($) => ({ ...this.target === "draft-7" ? { type: "string" } : {}, pattern: $.source }))];
            }
            break;
          }
          case "number": {
            let m = f, { minimum: g, maximum: h, format: y, multipleOf: v, exclusiveMaximum: w, exclusiveMinimum: x } = e._zod.bag;
            if (typeof y === "string" && y.includes("int")) m.type = "integer";
            else m.type = "number";
            if (typeof x === "number") m.exclusiveMinimum = x;
            if (typeof g === "number") {
              if (m.minimum = g, typeof x === "number") if (x >= g) delete m.minimum;
              else delete m.exclusiveMinimum;
            }
            if (typeof w === "number") m.exclusiveMaximum = w;
            if (typeof h === "number") {
              if (m.maximum = h, typeof w === "number") if (w <= h) delete m.maximum;
              else delete m.exclusiveMaximum;
            }
            if (typeof v === "number") m.multipleOf = v;
            break;
          }
          case "boolean": {
            let m = f;
            m.type = "boolean";
            break;
          }
          case "bigint": {
            if (this.unrepresentable === "throw") throw Error("BigInt cannot be represented in JSON Schema");
            break;
          }
          case "symbol": {
            if (this.unrepresentable === "throw") throw Error("Symbols cannot be represented in JSON Schema");
            break;
          }
          case "null": {
            f.type = "null";
            break;
          }
          case "any":
            break;
          case "unknown":
            break;
          case "undefined":
          case "never": {
            f.not = {};
            break;
          }
          case "void": {
            if (this.unrepresentable === "throw") throw Error("Void cannot be represented in JSON Schema");
            break;
          }
          case "date": {
            if (this.unrepresentable === "throw") throw Error("Date cannot be represented in JSON Schema");
            break;
          }
          case "array": {
            let m = f, { minimum: g, maximum: h } = e._zod.bag;
            if (typeof g === "number") m.minItems = g;
            if (typeof h === "number") m.maxItems = h;
            m.type = "array", m.items = this.process(o.element, { ...d, path: [...d.path, "items"] });
            break;
          }
          case "object": {
            let m = f;
            m.type = "object", m.properties = {};
            let g = o.shape;
            for (let v in g) m.properties[v] = this.process(g[v], { ...d, path: [...d.path, "properties", v] });
            let h = new Set(Object.keys(g)), y = new Set([...h].filter((v) => {
              let w = o.shape[v]._zod;
              if (this.io === "input") return w.optin === void 0;
              else return w.optout === void 0;
            }));
            if (y.size > 0) m.required = Array.from(y);
            if (o.catchall?._zod.def.type === "never") m.additionalProperties = false;
            else if (!o.catchall) {
              if (this.io === "output") m.additionalProperties = false;
            } else if (o.catchall) m.additionalProperties = this.process(o.catchall, { ...d, path: [...d.path, "additionalProperties"] });
            break;
          }
          case "union": {
            let m = f;
            m.anyOf = o.options.map((g, h) => this.process(g, { ...d, path: [...d.path, "anyOf", h] }));
            break;
          }
          case "intersection": {
            let m = f, g = this.process(o.left, { ...d, path: [...d.path, "allOf", 0] }), h = this.process(o.right, { ...d, path: [...d.path, "allOf", 1] }), y = (w) => "allOf" in w && Object.keys(w).length === 1, v = [...y(g) ? g.allOf : [g], ...y(h) ? h.allOf : [h]];
            m.allOf = v;
            break;
          }
          case "tuple": {
            let m = f;
            m.type = "array";
            let g = o.items.map((v, w) => this.process(v, { ...d, path: [...d.path, "prefixItems", w] }));
            if (this.target === "draft-2020-12") m.prefixItems = g;
            else m.items = g;
            if (o.rest) {
              let v = this.process(o.rest, { ...d, path: [...d.path, "items"] });
              if (this.target === "draft-2020-12") m.items = v;
              else m.additionalItems = v;
            }
            if (o.rest) m.items = this.process(o.rest, { ...d, path: [...d.path, "items"] });
            let { minimum: h, maximum: y } = e._zod.bag;
            if (typeof h === "number") m.minItems = h;
            if (typeof y === "number") m.maxItems = y;
            break;
          }
          case "record": {
            let m = f;
            m.type = "object", m.propertyNames = this.process(o.keyType, { ...d, path: [...d.path, "propertyNames"] }), m.additionalProperties = this.process(o.valueType, { ...d, path: [...d.path, "additionalProperties"] });
            break;
          }
          case "map": {
            if (this.unrepresentable === "throw") throw Error("Map cannot be represented in JSON Schema");
            break;
          }
          case "set": {
            if (this.unrepresentable === "throw") throw Error("Set cannot be represented in JSON Schema");
            break;
          }
          case "enum": {
            let m = f, g = Ec(o.entries);
            if (g.every((h) => typeof h === "number")) m.type = "number";
            if (g.every((h) => typeof h === "string")) m.type = "string";
            m.enum = g;
            break;
          }
          case "literal": {
            let m = f, g = [];
            for (let h of o.values) if (h === void 0) {
              if (this.unrepresentable === "throw") throw Error("Literal `undefined` cannot be represented in JSON Schema");
            } else if (typeof h === "bigint") if (this.unrepresentable === "throw") throw Error("BigInt literals cannot be represented in JSON Schema");
            else g.push(Number(h));
            else g.push(h);
            if (g.length === 0) ;
            else if (g.length === 1) {
              let h = g[0];
              m.type = h === null ? "null" : typeof h, m.const = h;
            } else {
              if (g.every((h) => typeof h === "number")) m.type = "number";
              if (g.every((h) => typeof h === "string")) m.type = "string";
              if (g.every((h) => typeof h === "boolean")) m.type = "string";
              if (g.every((h) => h === null)) m.type = "null";
              m.enum = g;
            }
            break;
          }
          case "file": {
            let m = f, g = { type: "string", format: "binary", contentEncoding: "binary" }, { minimum: h, maximum: y, mime: v } = e._zod.bag;
            if (h !== void 0) g.minLength = h;
            if (y !== void 0) g.maxLength = y;
            if (v) if (v.length === 1) g.contentMediaType = v[0], Object.assign(m, g);
            else m.anyOf = v.map((w) => ({ ...g, contentMediaType: w }));
            else Object.assign(m, g);
            break;
          }
          case "transform": {
            if (this.unrepresentable === "throw") throw Error("Transforms cannot be represented in JSON Schema");
            break;
          }
          case "nullable": {
            let m = this.process(o.innerType, d);
            f.anyOf = [m, { type: "null" }];
            break;
          }
          case "nonoptional": {
            this.process(o.innerType, d), s.ref = o.innerType;
            break;
          }
          case "success": {
            let m = f;
            m.type = "boolean";
            break;
          }
          case "default": {
            this.process(o.innerType, d), s.ref = o.innerType, f.default = JSON.parse(JSON.stringify(o.defaultValue));
            break;
          }
          case "prefault": {
            if (this.process(o.innerType, d), s.ref = o.innerType, this.io === "input") f._prefault = JSON.parse(JSON.stringify(o.defaultValue));
            break;
          }
          case "catch": {
            this.process(o.innerType, d), s.ref = o.innerType;
            let m;
            try {
              m = o.catchValue(void 0);
            } catch {
              throw Error("Dynamic catch values are not supported in JSON Schema");
            }
            f.default = m;
            break;
          }
          case "nan": {
            if (this.unrepresentable === "throw") throw Error("NaN cannot be represented in JSON Schema");
            break;
          }
          case "template_literal": {
            let m = f, g = e._zod.pattern;
            if (!g) throw Error("Pattern not found in template literal");
            m.type = "string", m.pattern = g.source;
            break;
          }
          case "pipe": {
            let m = this.io === "input" ? o.in._zod.def.type === "transform" ? o.out : o.in : o.out;
            this.process(m, d), s.ref = m;
            break;
          }
          case "readonly": {
            this.process(o.innerType, d), s.ref = o.innerType, f.readOnly = true;
            break;
          }
          case "promise": {
            this.process(o.innerType, d), s.ref = o.innerType;
            break;
          }
          case "optional": {
            this.process(o.innerType, d), s.ref = o.innerType;
            break;
          }
          case "lazy": {
            let m = e._zod.innerType;
            this.process(m, d), s.ref = m;
            break;
          }
          case "custom": {
            if (this.unrepresentable === "throw") throw Error("Custom types cannot be represented in JSON Schema");
            break;
          }
          default:
        }
      }
    }
    let c = this.metadataRegistry.get(e);
    if (c) Object.assign(s.schema, c);
    if (this.io === "input" && Je(e)) delete s.schema.examples, delete s.schema.default;
    if (this.io === "input" && s.schema._prefault) (r = s.schema).default ?? (r.default = s.schema._prefault);
    return delete s.schema._prefault, this.seen.get(e).schema;
  }
  emit(e, t) {
    let r = { cycles: t?.cycles ?? "ref", reused: t?.reused ?? "inline", external: t?.external ?? void 0 }, o = this.seen.get(e);
    if (!o) throw Error("Unprocessed schema. This is a bug in Zod.");
    let n = (u) => {
      let d = this.target === "draft-2020-12" ? "$defs" : "definitions";
      if (r.external) {
        let g = r.external.registry.get(u[0])?.id;
        if (g) return { ref: r.external.uri(g) };
        let h = u[1].defId ?? u[1].schema.id ?? `schema${this.counter++}`;
        return u[1].defId = h, { defId: h, ref: `${r.external.uri("__shared")}#/${d}/${h}` };
      }
      if (u[1] === o) return { ref: "#" };
      let f = `${"#"}/${d}/`, m = u[1].schema.id ?? `__schema${this.counter++}`;
      return { defId: m, ref: f + m };
    }, i = (u) => {
      if (u[1].schema.$ref) return;
      let d = u[1], { ref: p, defId: f } = n(u);
      if (d.def = { ...d.schema }, f) d.defId = f;
      let m = d.schema;
      for (let g in m) delete m[g];
      m.$ref = p;
    };
    for (let u of this.seen.entries()) {
      let d = u[1];
      if (e === u[0]) {
        i(u);
        continue;
      }
      if (r.external) {
        let f = r.external.registry.get(u[0])?.id;
        if (e !== u[0] && f) {
          i(u);
          continue;
        }
      }
      if (this.metadataRegistry.get(u[0])?.id) {
        i(u);
        continue;
      }
      if (d.cycle) {
        if (r.cycles === "throw") throw Error(`Cycle detected: #/${d.cycle?.join("/")}/<root>

Set the \`cycles\` parameter to \`"ref"\` to resolve cyclical schemas with defs.`);
        else if (r.cycles === "ref") i(u);
        continue;
      }
      if (d.count > 1) {
        if (r.reused === "ref") {
          i(u);
          continue;
        }
      }
    }
    let s = (u, d) => {
      let p = this.seen.get(u), f = p.def ?? p.schema, m = { ...f };
      if (p.ref === null) return;
      let g = p.ref;
      if (p.ref = null, g) {
        s(g, d);
        let h = this.seen.get(g).schema;
        if (h.$ref && d.target === "draft-7") f.allOf = f.allOf ?? [], f.allOf.push(h);
        else Object.assign(f, h), Object.assign(f, m);
      }
      if (!p.isParent) this.override({ zodSchema: u, jsonSchema: f, path: p.path ?? [] });
    };
    for (let u of [...this.seen.entries()].reverse()) s(u[0], { target: this.target });
    let a = {};
    if (this.target === "draft-2020-12") a.$schema = "https://json-schema.org/draft/2020-12/schema";
    else if (this.target === "draft-7") a.$schema = "http://json-schema.org/draft-07/schema#";
    else console.warn(`Invalid target: ${this.target}`);
    Object.assign(a, o.def);
    let c = r.external?.defs ?? {};
    for (let u of this.seen.entries()) {
      let d = u[1];
      if (d.def && d.defId) c[d.defId] = d.def;
    }
    if (!r.external && Object.keys(c).length > 0) if (this.target === "draft-2020-12") a.$defs = c;
    else a.definitions = c;
    try {
      return JSON.parse(JSON.stringify(a));
    } catch (u) {
      throw Error("Error converting schema to JSON.");
    }
  }
};
function ls(e, t) {
  if (e instanceof jc) {
    let o = new Nf(t), n = {};
    for (let a of e._idmap.entries()) {
      let [c, u] = a;
      o.process(u);
    }
    let i = {}, s = { registry: e, uri: t?.uri || ((a) => a), defs: n };
    for (let a of e._idmap.entries()) {
      let [c, u] = a;
      i[c] = o.emit(u, { ...t, external: s });
    }
    if (Object.keys(n).length > 0) {
      let a = o.target === "draft-2020-12" ? "$defs" : "definitions";
      i.__shared = { [a]: n };
    }
    return { schemas: i };
  }
  let r = new Nf(t);
  return r.process(e), r.emit(e, t);
}
function Je(e, t) {
  let r = t ?? { seen: /* @__PURE__ */ new Set() };
  if (r.seen.has(e)) return false;
  r.seen.add(e);
  let n = e._zod.def;
  switch (n.type) {
    case "string":
    case "number":
    case "bigint":
    case "boolean":
    case "date":
    case "symbol":
    case "undefined":
    case "null":
    case "any":
    case "unknown":
    case "never":
    case "void":
    case "literal":
    case "enum":
    case "nan":
    case "file":
    case "template_literal":
      return false;
    case "array":
      return Je(n.element, r);
    case "object": {
      for (let i in n.shape) if (Je(n.shape[i], r)) return true;
      return false;
    }
    case "union": {
      for (let i of n.options) if (Je(i, r)) return true;
      return false;
    }
    case "intersection":
      return Je(n.left, r) || Je(n.right, r);
    case "tuple": {
      for (let i of n.items) if (Je(i, r)) return true;
      if (n.rest && Je(n.rest, r)) return true;
      return false;
    }
    case "record":
      return Je(n.keyType, r) || Je(n.valueType, r);
    case "map":
      return Je(n.keyType, r) || Je(n.valueType, r);
    case "set":
      return Je(n.valueType, r);
    case "promise":
    case "optional":
    case "nonoptional":
    case "nullable":
    case "readonly":
      return Je(n.innerType, r);
    case "lazy":
      return Je(n.getter(), r);
    case "default":
      return Je(n.innerType, r);
    case "prefault":
      return Je(n.innerType, r);
    case "custom":
      return false;
    case "transform":
      return true;
    case "pipe":
      return Je(n.in, r) || Je(n.out, r);
    case "success":
      return false;
    case "catch":
      return false;
    default:
  }
  throw Error(`Unknown schema type: ${n.type}`);
}
var h$ = {};
var ZW = b("ZodMiniType", (e, t) => {
  if (!e._zod) throw Error("Uninitialized schema in ZodMiniType.");
  G.init(e, t), e.def = t, e.parse = (r, o) => Ro(e, r, o, { callee: e.parse }), e.safeParse = (r, o) => $n(e, r, o), e.parseAsync = async (r, o) => $o(e, r, o, { callee: e.parseAsync }), e.safeParseAsync = async (r, o) => An(e, r, o), e.check = (...r) => e.clone({ ...t, checks: [...t.checks ?? [], ...r.map((o) => typeof o === "function" ? { _zod: { check: o, def: { check: "custom" }, onattach: [] } } : o)] }), e.clone = (r, o) => ct(e, r, o), e.brand = () => e, e.register = (r, o) => (r.add(e, o), e);
});
var WW = b("ZodMiniObject", (e, t) => {
  Mc.init(e, t), ZW.init(e, t), O.defineLazy(e, "shape", () => t.shape);
});
var l = {};
kr(l, { xid: () => uK, void: () => AK, uuidv7: () => nK, uuidv6: () => rK, uuidv4: () => tK, uuid: () => eK, url: () => oK, uppercase: () => ll, unknown: () => Ae, union: () => we, undefined: () => RK, ulid: () => lK, uint64: () => TK, uint32: () => kK, tuple: () => DK, trim: () => gl, treeifyError: () => Qd, transform: () => Vv, toUpperCase: () => yl, toLowerCase: () => hl, toJSONSchema: () => ls, templateLiteral: () => qK, symbol: () => IK, superRefine: () => tA, success: () => HK, stringbool: () => WK, stringFormat: () => vK, string: () => S, strictObject: () => MK, startsWith: () => dl, size: () => sl, setErrorMap: () => JK, set: () => UK, safeParseAsync: () => Sv, safeParse: () => vv, registry: () => Uc, regexes: () => On, regex: () => al, refine: () => eA, record: () => ke, readonly: () => K$, property: () => uv, promise: () => VK, prettifyError: () => ep, preprocess: () => Qf, prefault: () => F$, positive: () => sv, pipe: () => Zf, partialRecord: () => NK, parseAsync: () => _v, parse: () => bv, overwrite: () => en, optional: () => Re, object: () => L, number: () => fe, nullish: () => FK, nullable: () => Vf, null: () => Wf, normalize: () => ml, nonpositive: () => cv, nonoptional: () => H$, nonnegative: () => lv, never: () => Kf, negative: () => av, nativeEnum: () => zK, nanoid: () => sK, nan: () => BK, multipleOf: () => Mo, minSize: () => Do, minLength: () => Dn, mime: () => fl, maxSize: () => ss, maxLength: () => as, map: () => jK, lte: () => Yt, lt: () => Yr, lowercase: () => cl, looseObject: () => lt, locales: () => os, literal: () => H, length: () => cs, lazy: () => X$, ksuid: () => dK, keyof: () => CK, jwt: () => _K, json: () => KK, iso: () => ds, ipv6: () => fK, ipv4: () => pK, intersection: () => kl, int64: () => PK, int32: () => wK, int: () => xv, instanceof: () => ZK, includes: () => ul, guid: () => QW, gte: () => Pt, gt: () => Qr, globalRegistry: () => Et, getErrorMap: () => XK, function: () => Df, formatError: () => Yi, float64: () => xK, float32: () => SK, flattenError: () => Xi, file: () => LK, enum: () => gt, endsWith: () => pl, emoji: () => iK, email: () => YW, e164: () => bK, discriminatedUnion: () => Xf, date: () => OK, custom: () => Gv, cuid2: () => cK, cuid: () => aK, core: () => pr, config: () => Be, coerce: () => Jv, clone: () => ct, cidrv6: () => gK, cidrv4: () => mK, check: () => Q$, catch: () => V$, boolean: () => We, bigint: () => EK, base64url: () => yK, base64: () => hK, array: () => ie, any: () => $K, _default: () => z$, _ZodString: () => wv, ZodXID: () => Av, ZodVoid: () => I$, ZodUnknown: () => P$, ZodUnion: () => Hv, ZodUndefined: () => w$, ZodUUID: () => tn, ZodURL: () => Ev, ZodULID: () => $v, ZodType: () => ne, ZodTuple: () => O$, ZodTransform: () => qv, ZodTemplateLiteral: () => G$, ZodSymbol: () => x$, ZodSuccess: () => B$, ZodStringFormat: () => Ie, ZodString: () => vl, ZodSet: () => M$, ZodRecord: () => Bv, ZodRealError: () => ps, ZodReadonly: () => W$, ZodPromise: () => Y$, ZodPrefault: () => L$, ZodPipe: () => Kv, ZodOptional: () => Zv, ZodObject: () => Jf, ZodNumberFormat: () => fs, ZodNumber: () => Sl, ZodNullable: () => j$, ZodNull: () => k$, ZodNonOptional: () => Wv, ZodNever: () => T$, ZodNanoID: () => Tv, ZodNaN: () => Z$, ZodMap: () => C$, ZodLiteral: () => D$, ZodLazy: () => J$, ZodKSUID: () => Ov, ZodJWT: () => Lv, ZodIssueCode: () => GK, ZodIntersection: () => A$, ZodISOTime: () => Hf, ZodISODuration: () => Bf, ZodISODateTime: () => Lf, ZodISODate: () => Ff, ZodIPv6: () => Mv, ZodIPv4: () => Cv, ZodGUID: () => qf, ZodFile: () => N$, ZodError: () => JW, ZodEnum: () => _l, ZodEmoji: () => Pv, ZodEmail: () => kv, ZodE164: () => zv, ZodDiscriminatedUnion: () => $$, ZodDefault: () => U$, ZodDate: () => Gf, ZodCustomStringFormat: () => S$, ZodCustom: () => Yf, ZodCatch: () => q$, ZodCUID2: () => Rv, ZodCUID: () => Iv, ZodCIDRv6: () => Nv, ZodCIDRv4: () => Dv, ZodBoolean: () => xl, ZodBigIntFormat: () => Fv, ZodBigInt: () => wl, ZodBase64URL: () => Uv, ZodBase64: () => jv, ZodArray: () => R$, ZodAny: () => E$, TimePrecision: () => df, NEVER: () => Jd, $output: () => cf, $input: () => lf, $brand: () => Xd });
var ds = {};
kr(ds, { time: () => hv, duration: () => yv, datetime: () => mv, date: () => gv, ZodISOTime: () => Hf, ZodISODuration: () => Bf, ZodISODateTime: () => Lf, ZodISODate: () => Ff });
var Lf = b("ZodISODateTime", (e, t) => {
  c_.init(e, t), Ie.init(e, t);
});
function mv(e) {
  return Y_(Lf, e);
}
var Ff = b("ZodISODate", (e, t) => {
  l_.init(e, t), Ie.init(e, t);
});
function gv(e) {
  return Q_(Ff, e);
}
var Hf = b("ZodISOTime", (e, t) => {
  u_.init(e, t), Ie.init(e, t);
});
function hv(e) {
  return ev(Hf, e);
}
var Bf = b("ZodISODuration", (e, t) => {
  d_.init(e, t), Ie.init(e, t);
});
function yv(e) {
  return tv(Bf, e);
}
var v$ = (e, t) => {
  Ac.init(e, t), e.name = "ZodError", Object.defineProperties(e, { format: { value: (r) => Yi(e, r) }, flatten: { value: (r) => Xi(e, r) }, addIssue: { value: (r) => e.issues.push(r) }, addIssues: { value: (r) => e.issues.push(...r) }, isEmpty: { get() {
    return e.issues.length === 0;
  } } });
};
var JW = b("ZodError", v$);
var ps = b("ZodError", v$, { Parent: Error });
var bv = tp(ps);
var _v = rp(ps);
var vv = np(ps);
var Sv = op(ps);
var ne = b("ZodType", (e, t) => (G.init(e, t), e.def = t, Object.defineProperty(e, "_def", { value: t }), e.check = (...r) => e.clone({ ...t, checks: [...t.checks ?? [], ...r.map((o) => typeof o === "function" ? { _zod: { check: o, def: { check: "custom" }, onattach: [] } } : o)] }), e.clone = (r, o) => ct(e, r, o), e.brand = () => e, e.register = (r, o) => (r.add(e, o), e), e.parse = (r, o) => bv(e, r, o, { callee: e.parse }), e.safeParse = (r, o) => vv(e, r, o), e.parseAsync = async (r, o) => _v(e, r, o, { callee: e.parseAsync }), e.safeParseAsync = async (r, o) => Sv(e, r, o), e.spa = e.safeParseAsync, e.refine = (r, o) => e.check(eA(r, o)), e.superRefine = (r) => e.check(tA(r)), e.overwrite = (r) => e.check(en(r)), e.optional = () => Re(e), e.nullable = () => Vf(e), e.nullish = () => Re(Vf(e)), e.nonoptional = (r) => H$(e, r), e.array = () => ie(e), e.or = (r) => we([e, r]), e.and = (r) => kl(e, r), e.transform = (r) => Zf(e, Vv(r)), e.default = (r) => z$(e, r), e.prefault = (r) => F$(e, r), e.catch = (r) => V$(e, r), e.pipe = (r) => Zf(e, r), e.readonly = () => K$(e), e.describe = (r) => {
  let o = e.clone();
  return Et.add(o, { description: r }), o;
}, Object.defineProperty(e, "description", { get() {
  return Et.get(e)?.description;
}, configurable: true }), e.meta = (...r) => {
  if (r.length === 0) return Et.get(e);
  let o = e.clone();
  return Et.add(o, r[0]), o;
}, e.isOptional = () => e.safeParse(void 0).success, e.isNullable = () => e.safeParse(null).success, e));
var wv = b("_ZodString", (e, t) => {
  Cn.init(e, t), ne.init(e, t);
  let r = e._zod.bag;
  e.format = r.format ?? null, e.minLength = r.minimum ?? null, e.maxLength = r.maximum ?? null, e.regex = (...o) => e.check(al(...o)), e.includes = (...o) => e.check(ul(...o)), e.startsWith = (...o) => e.check(dl(...o)), e.endsWith = (...o) => e.check(pl(...o)), e.min = (...o) => e.check(Dn(...o)), e.max = (...o) => e.check(as(...o)), e.length = (...o) => e.check(cs(...o)), e.nonempty = (...o) => e.check(Dn(1, ...o)), e.lowercase = (o) => e.check(cl(o)), e.uppercase = (o) => e.check(ll(o)), e.trim = () => e.check(gl()), e.normalize = (...o) => e.check(ml(...o)), e.toLowerCase = () => e.check(hl()), e.toUpperCase = () => e.check(yl());
});
var vl = b("ZodString", (e, t) => {
  Cn.init(e, t), wv.init(e, t), e.email = (r) => e.check(zc(kv, r)), e.url = (r) => e.check(qc(Ev, r)), e.jwt = (r) => e.check(il(Lv, r)), e.emoji = (r) => e.check(Vc(Pv, r)), e.guid = (r) => e.check(is(qf, r)), e.uuid = (r) => e.check(Lc(tn, r)), e.uuidv4 = (r) => e.check(Fc(tn, r)), e.uuidv6 = (r) => e.check(Hc(tn, r)), e.uuidv7 = (r) => e.check(Bc(tn, r)), e.nanoid = (r) => e.check(Zc(Tv, r)), e.guid = (r) => e.check(is(qf, r)), e.cuid = (r) => e.check(Wc(Iv, r)), e.cuid2 = (r) => e.check(Kc(Rv, r)), e.ulid = (r) => e.check(Gc($v, r)), e.base64 = (r) => e.check(rl(jv, r)), e.base64url = (r) => e.check(nl(Uv, r)), e.xid = (r) => e.check(Jc(Av, r)), e.ksuid = (r) => e.check(Xc(Ov, r)), e.ipv4 = (r) => e.check(Yc(Cv, r)), e.ipv6 = (r) => e.check(Qc(Mv, r)), e.cidrv4 = (r) => e.check(el(Dv, r)), e.cidrv6 = (r) => e.check(tl(Nv, r)), e.e164 = (r) => e.check(ol(zv, r)), e.datetime = (r) => e.check(mv(r)), e.date = (r) => e.check(gv(r)), e.time = (r) => e.check(hv(r)), e.duration = (r) => e.check(yv(r));
});
function S(e) {
  return uf(vl, e);
}
var Ie = b("ZodStringFormat", (e, t) => {
  xe.init(e, t), wv.init(e, t);
});
var kv = b("ZodEmail", (e, t) => {
  fp.init(e, t), Ie.init(e, t);
});
function YW(e) {
  return zc(kv, e);
}
var qf = b("ZodGUID", (e, t) => {
  dp.init(e, t), Ie.init(e, t);
});
function QW(e) {
  return is(qf, e);
}
var tn = b("ZodUUID", (e, t) => {
  pp.init(e, t), Ie.init(e, t);
});
function eK(e) {
  return Lc(tn, e);
}
function tK(e) {
  return Fc(tn, e);
}
function rK(e) {
  return Hc(tn, e);
}
function nK(e) {
  return Bc(tn, e);
}
var Ev = b("ZodURL", (e, t) => {
  mp.init(e, t), Ie.init(e, t);
});
function oK(e) {
  return qc(Ev, e);
}
var Pv = b("ZodEmoji", (e, t) => {
  gp.init(e, t), Ie.init(e, t);
});
function iK(e) {
  return Vc(Pv, e);
}
var Tv = b("ZodNanoID", (e, t) => {
  hp.init(e, t), Ie.init(e, t);
});
function sK(e) {
  return Zc(Tv, e);
}
var Iv = b("ZodCUID", (e, t) => {
  yp.init(e, t), Ie.init(e, t);
});
function aK(e) {
  return Wc(Iv, e);
}
var Rv = b("ZodCUID2", (e, t) => {
  bp.init(e, t), Ie.init(e, t);
});
function cK(e) {
  return Kc(Rv, e);
}
var $v = b("ZodULID", (e, t) => {
  _p.init(e, t), Ie.init(e, t);
});
function lK(e) {
  return Gc($v, e);
}
var Av = b("ZodXID", (e, t) => {
  vp.init(e, t), Ie.init(e, t);
});
function uK(e) {
  return Jc(Av, e);
}
var Ov = b("ZodKSUID", (e, t) => {
  Sp.init(e, t), Ie.init(e, t);
});
function dK(e) {
  return Xc(Ov, e);
}
var Cv = b("ZodIPv4", (e, t) => {
  xp.init(e, t), Ie.init(e, t);
});
function pK(e) {
  return Yc(Cv, e);
}
var Mv = b("ZodIPv6", (e, t) => {
  wp.init(e, t), Ie.init(e, t);
});
function fK(e) {
  return Qc(Mv, e);
}
var Dv = b("ZodCIDRv4", (e, t) => {
  kp.init(e, t), Ie.init(e, t);
});
function mK(e) {
  return el(Dv, e);
}
var Nv = b("ZodCIDRv6", (e, t) => {
  Ep.init(e, t), Ie.init(e, t);
});
function gK(e) {
  return tl(Nv, e);
}
var jv = b("ZodBase64", (e, t) => {
  Pp.init(e, t), Ie.init(e, t);
});
function hK(e) {
  return rl(jv, e);
}
var Uv = b("ZodBase64URL", (e, t) => {
  Tp.init(e, t), Ie.init(e, t);
});
function yK(e) {
  return nl(Uv, e);
}
var zv = b("ZodE164", (e, t) => {
  Ip.init(e, t), Ie.init(e, t);
});
function bK(e) {
  return ol(zv, e);
}
var Lv = b("ZodJWT", (e, t) => {
  Rp.init(e, t), Ie.init(e, t);
});
function _K(e) {
  return il(Lv, e);
}
var S$ = b("ZodCustomStringFormat", (e, t) => {
  $p.init(e, t), Ie.init(e, t);
});
function vK(e, t, r = {}) {
  return Mf(S$, e, t, r);
}
var Sl = b("ZodNumber", (e, t) => {
  Oc.init(e, t), ne.init(e, t), e.gt = (o, n) => e.check(Qr(o, n)), e.gte = (o, n) => e.check(Pt(o, n)), e.min = (o, n) => e.check(Pt(o, n)), e.lt = (o, n) => e.check(Yr(o, n)), e.lte = (o, n) => e.check(Yt(o, n)), e.max = (o, n) => e.check(Yt(o, n)), e.int = (o) => e.check(xv(o)), e.safe = (o) => e.check(xv(o)), e.positive = (o) => e.check(Qr(0, o)), e.nonnegative = (o) => e.check(Pt(0, o)), e.negative = (o) => e.check(Yr(0, o)), e.nonpositive = (o) => e.check(Yt(0, o)), e.multipleOf = (o, n) => e.check(Mo(o, n)), e.step = (o, n) => e.check(Mo(o, n)), e.finite = () => e;
  let r = e._zod.bag;
  e.minValue = Math.max(r.minimum ?? Number.NEGATIVE_INFINITY, r.exclusiveMinimum ?? Number.NEGATIVE_INFINITY) ?? null, e.maxValue = Math.min(r.maximum ?? Number.POSITIVE_INFINITY, r.exclusiveMaximum ?? Number.POSITIVE_INFINITY) ?? null, e.isInt = (r.format ?? "").includes("int") || Number.isSafeInteger(r.multipleOf ?? 0.5), e.isFinite = true, e.format = r.format ?? null;
});
function fe(e) {
  return pf(Sl, e);
}
var fs = b("ZodNumberFormat", (e, t) => {
  Ap.init(e, t), Sl.init(e, t);
});
function xv(e) {
  return ff(fs, e);
}
function SK(e) {
  return mf(fs, e);
}
function xK(e) {
  return gf(fs, e);
}
function wK(e) {
  return hf(fs, e);
}
function kK(e) {
  return yf(fs, e);
}
var xl = b("ZodBoolean", (e, t) => {
  es.init(e, t), ne.init(e, t);
});
function We(e) {
  return bf(xl, e);
}
var wl = b("ZodBigInt", (e, t) => {
  Cc.init(e, t), ne.init(e, t), e.gte = (o, n) => e.check(Pt(o, n)), e.min = (o, n) => e.check(Pt(o, n)), e.gt = (o, n) => e.check(Qr(o, n)), e.gte = (o, n) => e.check(Pt(o, n)), e.min = (o, n) => e.check(Pt(o, n)), e.lt = (o, n) => e.check(Yr(o, n)), e.lte = (o, n) => e.check(Yt(o, n)), e.max = (o, n) => e.check(Yt(o, n)), e.positive = (o) => e.check(Qr(BigInt(0), o)), e.negative = (o) => e.check(Yr(BigInt(0), o)), e.nonpositive = (o) => e.check(Yt(BigInt(0), o)), e.nonnegative = (o) => e.check(Pt(BigInt(0), o)), e.multipleOf = (o, n) => e.check(Mo(o, n));
  let r = e._zod.bag;
  e.minValue = r.minimum ?? null, e.maxValue = r.maximum ?? null, e.format = r.format ?? null;
});
function EK(e) {
  return _f(wl, e);
}
var Fv = b("ZodBigIntFormat", (e, t) => {
  Op.init(e, t), wl.init(e, t);
});
function PK(e) {
  return vf(Fv, e);
}
function TK(e) {
  return Sf(Fv, e);
}
var x$ = b("ZodSymbol", (e, t) => {
  Cp.init(e, t), ne.init(e, t);
});
function IK(e) {
  return xf(x$, e);
}
var w$ = b("ZodUndefined", (e, t) => {
  Mp.init(e, t), ne.init(e, t);
});
function RK(e) {
  return wf(w$, e);
}
var k$ = b("ZodNull", (e, t) => {
  Dp.init(e, t), ne.init(e, t);
});
function Wf(e) {
  return kf(k$, e);
}
var E$ = b("ZodAny", (e, t) => {
  Np.init(e, t), ne.init(e, t);
});
function $K() {
  return Ef(E$);
}
var P$ = b("ZodUnknown", (e, t) => {
  Oo.init(e, t), ne.init(e, t);
});
function Ae() {
  return Co(P$);
}
var T$ = b("ZodNever", (e, t) => {
  jp.init(e, t), ne.init(e, t);
});
function Kf(e) {
  return Pf(T$, e);
}
var I$ = b("ZodVoid", (e, t) => {
  Up.init(e, t), ne.init(e, t);
});
function AK(e) {
  return Tf(I$, e);
}
var Gf = b("ZodDate", (e, t) => {
  zp.init(e, t), ne.init(e, t), e.min = (o, n) => e.check(Pt(o, n)), e.max = (o, n) => e.check(Yt(o, n));
  let r = e._zod.bag;
  e.minDate = r.minimum ? new Date(r.minimum) : null, e.maxDate = r.maximum ? new Date(r.maximum) : null;
});
function OK(e) {
  return If(Gf, e);
}
var R$ = b("ZodArray", (e, t) => {
  ts.init(e, t), ne.init(e, t), e.element = t.element, e.min = (r, o) => e.check(Dn(r, o)), e.nonempty = (r) => e.check(Dn(1, r)), e.max = (r, o) => e.check(as(r, o)), e.length = (r, o) => e.check(cs(r, o)), e.unwrap = () => e.element;
});
function ie(e, t) {
  return bl(R$, e, t);
}
function CK(e) {
  let t = e._zod.def.shape;
  return H(Object.keys(t));
}
var Jf = b("ZodObject", (e, t) => {
  Mc.init(e, t), ne.init(e, t), O.defineLazy(e, "shape", () => t.shape), e.keyof = () => gt(Object.keys(e._zod.def.shape)), e.catchall = (r) => e.clone({ ...e._zod.def, catchall: r }), e.passthrough = () => e.clone({ ...e._zod.def, catchall: Ae() }), e.loose = () => e.clone({ ...e._zod.def, catchall: Ae() }), e.strict = () => e.clone({ ...e._zod.def, catchall: Kf() }), e.strip = () => e.clone({ ...e._zod.def, catchall: void 0 }), e.extend = (r) => O.extend(e, r), e.merge = (r) => O.merge(e, r), e.pick = (r) => O.pick(e, r), e.omit = (r) => O.omit(e, r), e.partial = (...r) => O.partial(Zv, e, r[0]), e.required = (...r) => O.required(Wv, e, r[0]);
});
function L(e, t) {
  let r = { type: "object", get shape() {
    return O.assignProp(this, "shape", { ...e }), this.shape;
  }, ...O.normalizeParams(t) };
  return new Jf(r);
}
function MK(e, t) {
  return new Jf({ type: "object", get shape() {
    return O.assignProp(this, "shape", { ...e }), this.shape;
  }, catchall: Kf(), ...O.normalizeParams(t) });
}
function lt(e, t) {
  return new Jf({ type: "object", get shape() {
    return O.assignProp(this, "shape", { ...e }), this.shape;
  }, catchall: Ae(), ...O.normalizeParams(t) });
}
var Hv = b("ZodUnion", (e, t) => {
  Dc.init(e, t), ne.init(e, t), e.options = t.options;
});
function we(e, t) {
  return new Hv({ type: "union", options: e, ...O.normalizeParams(t) });
}
var $$ = b("ZodDiscriminatedUnion", (e, t) => {
  Hv.init(e, t), Lp.init(e, t);
});
function Xf(e, t, r) {
  return new $$({ type: "union", options: t, discriminator: e, ...O.normalizeParams(r) });
}
var A$ = b("ZodIntersection", (e, t) => {
  Fp.init(e, t), ne.init(e, t);
});
function kl(e, t) {
  return new A$({ type: "intersection", left: e, right: t });
}
var O$ = b("ZodTuple", (e, t) => {
  Mn.init(e, t), ne.init(e, t), e.rest = (r) => e.clone({ ...e._zod.def, rest: r });
});
function DK(e, t, r) {
  let o = t instanceof G, n = o ? r : t;
  return new O$({ type: "tuple", items: e, rest: o ? t : null, ...O.normalizeParams(n) });
}
var Bv = b("ZodRecord", (e, t) => {
  Hp.init(e, t), ne.init(e, t), e.keyType = t.keyType, e.valueType = t.valueType;
});
function ke(e, t, r) {
  return new Bv({ type: "record", keyType: e, valueType: t, ...O.normalizeParams(r) });
}
function NK(e, t, r) {
  return new Bv({ type: "record", keyType: we([e, Kf()]), valueType: t, ...O.normalizeParams(r) });
}
var C$ = b("ZodMap", (e, t) => {
  Bp.init(e, t), ne.init(e, t), e.keyType = t.keyType, e.valueType = t.valueType;
});
function jK(e, t, r) {
  return new C$({ type: "map", keyType: e, valueType: t, ...O.normalizeParams(r) });
}
var M$ = b("ZodSet", (e, t) => {
  qp.init(e, t), ne.init(e, t), e.min = (...r) => e.check(Do(...r)), e.nonempty = (r) => e.check(Do(1, r)), e.max = (...r) => e.check(ss(...r)), e.size = (...r) => e.check(sl(...r));
});
function UK(e, t) {
  return new M$({ type: "set", valueType: e, ...O.normalizeParams(t) });
}
var _l = b("ZodEnum", (e, t) => {
  Vp.init(e, t), ne.init(e, t), e.enum = t.entries, e.options = Object.values(t.entries);
  let r = new Set(Object.keys(t.entries));
  e.extract = (o, n) => {
    let i = {};
    for (let s of o) if (r.has(s)) i[s] = t.entries[s];
    else throw Error(`Key ${s} not found in enum`);
    return new _l({ ...t, checks: [], ...O.normalizeParams(n), entries: i });
  }, e.exclude = (o, n) => {
    let i = { ...t.entries };
    for (let s of o) if (r.has(s)) delete i[s];
    else throw Error(`Key ${s} not found in enum`);
    return new _l({ ...t, checks: [], ...O.normalizeParams(n), entries: i });
  };
});
function gt(e, t) {
  let r = Array.isArray(e) ? Object.fromEntries(e.map((o) => [o, o])) : e;
  return new _l({ type: "enum", entries: r, ...O.normalizeParams(t) });
}
function zK(e, t) {
  return new _l({ type: "enum", entries: e, ...O.normalizeParams(t) });
}
var D$ = b("ZodLiteral", (e, t) => {
  Zp.init(e, t), ne.init(e, t), e.values = new Set(t.values), Object.defineProperty(e, "value", { get() {
    if (t.values.length > 1) throw Error("This schema contains multiple valid literal values. Use `.values` instead.");
    return t.values[0];
  } });
});
function H(e, t) {
  return new D$({ type: "literal", values: Array.isArray(e) ? e : [e], ...O.normalizeParams(t) });
}
var N$ = b("ZodFile", (e, t) => {
  Wp.init(e, t), ne.init(e, t), e.min = (r, o) => e.check(Do(r, o)), e.max = (r, o) => e.check(ss(r, o)), e.mime = (r, o) => e.check(fl(Array.isArray(r) ? r : [r], o));
});
function LK(e) {
  return $f(N$, e);
}
var qv = b("ZodTransform", (e, t) => {
  rs.init(e, t), ne.init(e, t), e._zod.parse = (r, o) => {
    r.addIssue = (i) => {
      if (typeof i === "string") r.issues.push(O.issue(i, r.value, t));
      else {
        let s = i;
        if (s.fatal) s.continue = false;
        s.code ?? (s.code = "custom"), s.input ?? (s.input = r.value), s.inst ?? (s.inst = e), s.continue ?? (s.continue = true), r.issues.push(O.issue(s));
      }
    };
    let n = t.transform(r.value, r);
    if (n instanceof Promise) return n.then((i) => (r.value = i, r));
    return r.value = n, r;
  };
});
function Vv(e) {
  return new qv({ type: "transform", transform: e });
}
var Zv = b("ZodOptional", (e, t) => {
  Kp.init(e, t), ne.init(e, t), e.unwrap = () => e._zod.def.innerType;
});
function Re(e) {
  return new Zv({ type: "optional", innerType: e });
}
var j$ = b("ZodNullable", (e, t) => {
  Gp.init(e, t), ne.init(e, t), e.unwrap = () => e._zod.def.innerType;
});
function Vf(e) {
  return new j$({ type: "nullable", innerType: e });
}
function FK(e) {
  return Re(Vf(e));
}
var U$ = b("ZodDefault", (e, t) => {
  Jp.init(e, t), ne.init(e, t), e.unwrap = () => e._zod.def.innerType, e.removeDefault = e.unwrap;
});
function z$(e, t) {
  return new U$({ type: "default", innerType: e, get defaultValue() {
    return typeof t === "function" ? t() : t;
  } });
}
var L$ = b("ZodPrefault", (e, t) => {
  Xp.init(e, t), ne.init(e, t), e.unwrap = () => e._zod.def.innerType;
});
function F$(e, t) {
  return new L$({ type: "prefault", innerType: e, get defaultValue() {
    return typeof t === "function" ? t() : t;
  } });
}
var Wv = b("ZodNonOptional", (e, t) => {
  Yp.init(e, t), ne.init(e, t), e.unwrap = () => e._zod.def.innerType;
});
function H$(e, t) {
  return new Wv({ type: "nonoptional", innerType: e, ...O.normalizeParams(t) });
}
var B$ = b("ZodSuccess", (e, t) => {
  Qp.init(e, t), ne.init(e, t), e.unwrap = () => e._zod.def.innerType;
});
function HK(e) {
  return new B$({ type: "success", innerType: e });
}
var q$ = b("ZodCatch", (e, t) => {
  ef.init(e, t), ne.init(e, t), e.unwrap = () => e._zod.def.innerType, e.removeCatch = e.unwrap;
});
function V$(e, t) {
  return new q$({ type: "catch", innerType: e, catchValue: typeof t === "function" ? t : () => t });
}
var Z$ = b("ZodNaN", (e, t) => {
  tf.init(e, t), ne.init(e, t);
});
function BK(e) {
  return Rf(Z$, e);
}
var Kv = b("ZodPipe", (e, t) => {
  ns.init(e, t), ne.init(e, t), e.in = t.in, e.out = t.out;
});
function Zf(e, t) {
  return new Kv({ type: "pipe", in: e, out: t });
}
var W$ = b("ZodReadonly", (e, t) => {
  rf.init(e, t), ne.init(e, t);
});
function K$(e) {
  return new W$({ type: "readonly", innerType: e });
}
var G$ = b("ZodTemplateLiteral", (e, t) => {
  nf.init(e, t), ne.init(e, t);
});
function qK(e, t) {
  return new G$({ type: "template_literal", parts: e, ...O.normalizeParams(t) });
}
var J$ = b("ZodLazy", (e, t) => {
  sf.init(e, t), ne.init(e, t), e.unwrap = () => e._zod.def.getter();
});
function X$(e) {
  return new J$({ type: "lazy", getter: e });
}
var Y$ = b("ZodPromise", (e, t) => {
  of.init(e, t), ne.init(e, t), e.unwrap = () => e._zod.def.innerType;
});
function VK(e) {
  return new Y$({ type: "promise", innerType: e });
}
var Yf = b("ZodCustom", (e, t) => {
  af.init(e, t), ne.init(e, t);
});
function Q$(e, t) {
  let r = new Me({ check: "custom", ...O.normalizeParams(t) });
  return r._zod.check = e, r;
}
function Gv(e, t) {
  return Af(Yf, e ?? (() => true), t);
}
function eA(e, t = {}) {
  return Of(Yf, e, t);
}
function tA(e, t) {
  let r = Q$((o) => (o.addIssue = (n) => {
    if (typeof n === "string") o.issues.push(O.issue(n, o.value, r._zod.def));
    else {
      let i = n;
      if (i.fatal) i.continue = false;
      i.code ?? (i.code = "custom"), i.input ?? (i.input = o.value), i.inst ?? (i.inst = r), i.continue ?? (i.continue = !r._zod.def.abort), o.issues.push(O.issue(i));
    }
  }, e(o.value, o)), t);
  return r;
}
function ZK(e, t = { error: `Input not instance of ${e.name}` }) {
  let r = new Yf({ type: "custom", check: "custom", fn: (o) => o instanceof e, abort: true, ...O.normalizeParams(t) });
  return r._zod.bag.Class = e, r;
}
var WK = (...e) => Cf({ Pipe: Kv, Boolean: xl, String: vl, Transform: qv }, ...e);
function KK(e) {
  let t = X$(() => we([S(e), fe(), We(), Wf(), ie(t), ke(S(), t)]));
  return t;
}
function Qf(e, t) {
  return Zf(Vv(e), t);
}
var GK = { invalid_type: "invalid_type", too_big: "too_big", too_small: "too_small", invalid_format: "invalid_format", not_multiple_of: "not_multiple_of", unrecognized_keys: "unrecognized_keys", invalid_union: "invalid_union", invalid_key: "invalid_key", invalid_element: "invalid_element", invalid_value: "invalid_value", custom: "custom" };
function JK(e) {
  Be({ customError: e });
}
function XK() {
  return Be().customError;
}
var Jv = {};
kr(Jv, { string: () => YK, number: () => QK, date: () => r9, boolean: () => e9, bigint: () => t9 });
function YK(e) {
  return X_(vl, e);
}
function QK(e) {
  return rv(Sl, e);
}
function e9(e) {
  return nv(xl, e);
}
function t9(e) {
  return ov(wl, e);
}
function r9(e) {
  return iv(Gf, e);
}
Be(Nc());
var rA = l;
var Xv = rA;
var Un = "io.modelcontextprotocol/related-task";
var tm = "2.0";
var Xe = Gv((e) => e !== null && (typeof e === "object" || typeof e === "function"));
var oA = we([S(), fe().int()]);
var iA = S();
var Jxe = lt({ ttl: fe().optional(), pollInterval: fe().optional() });
var o9 = L({ ttl: fe().optional() });
var i9 = L({ taskId: S() });
var Qv = lt({ progressToken: oA.optional(), [Un]: i9.optional() });
var zt = L({ _meta: Qv.optional() });
var El = zt.extend({ task: o9.optional() });
var tt = L({ method: S(), params: zt.loose().optional() });
var er = L({ _meta: Qv.optional() });
var tr = L({ method: S(), params: er.loose().optional() });
var rt = lt({ _meta: Qv.optional() });
var rm = we([S(), fe().int()]);
var aA = L({ jsonrpc: H(tm), id: rm, ...tt.shape }).strict();
var cA = L({ jsonrpc: H(tm), ...tr.shape }).strict();
var tS = L({ jsonrpc: H(tm), id: rm, result: rt }).strict();
var V;
(function(e) {
  e[e.ConnectionClosed = -32e3] = "ConnectionClosed", e[e.RequestTimeout = -32001] = "RequestTimeout", e[e.ParseError = -32700] = "ParseError", e[e.InvalidRequest = -32600] = "InvalidRequest", e[e.MethodNotFound = -32601] = "MethodNotFound", e[e.InvalidParams = -32602] = "InvalidParams", e[e.InternalError = -32603] = "InternalError", e[e.UrlElicitationRequired = -32042] = "UrlElicitationRequired";
})(V || (V = {}));
var rS = L({ jsonrpc: H(tm), id: rm.optional(), error: L({ code: fe().int(), message: S(), data: Ae().optional() }) }).strict();
var Xxe = we([aA, cA, tS, rS]);
var Yxe = we([tS, rS]);
var nm = rt.strict();
var s9 = er.extend({ requestId: rm.optional(), reason: S().optional() });
var om = tr.extend({ method: H("notifications/cancelled"), params: s9 });
var a9 = L({ src: S(), mimeType: S().optional(), sizes: ie(S()).optional(), theme: gt(["light", "dark"]).optional() });
var Tl = L({ icons: ie(a9).optional() });
var ms = L({ name: S(), title: S().optional() });
var dA = ms.extend({ ...ms.shape, ...Tl.shape, version: S(), websiteUrl: S().optional(), description: S().optional() });
var c9 = kl(L({ applyDefaults: We().optional() }), ke(S(), Ae()));
var l9 = Qf((e) => {
  if (e && typeof e === "object" && !Array.isArray(e)) {
    if (Object.keys(e).length === 0) return { form: {} };
  }
  return e;
}, kl(L({ form: c9.optional(), url: Xe.optional() }), ke(S(), Ae()).optional()));
var u9 = lt({ list: Xe.optional(), cancel: Xe.optional(), requests: lt({ sampling: lt({ createMessage: Xe.optional() }).optional(), elicitation: lt({ create: Xe.optional() }).optional() }).optional() });
var d9 = lt({ list: Xe.optional(), cancel: Xe.optional(), requests: lt({ tools: lt({ call: Xe.optional() }).optional() }).optional() });
var p9 = L({ experimental: ke(S(), Xe).optional(), sampling: L({ context: Xe.optional(), tools: Xe.optional() }).optional(), elicitation: l9.optional(), roots: L({ listChanged: We().optional() }).optional(), tasks: u9.optional(), extensions: ke(S(), Xe).optional() });
var f9 = zt.extend({ protocolVersion: S(), capabilities: p9, clientInfo: dA });
var nS = tt.extend({ method: H("initialize"), params: f9 });
var m9 = L({ experimental: ke(S(), Xe).optional(), logging: Xe.optional(), completions: Xe.optional(), prompts: L({ listChanged: We().optional() }).optional(), resources: L({ subscribe: We().optional(), listChanged: We().optional() }).optional(), tools: L({ listChanged: We().optional() }).optional(), tasks: d9.optional(), extensions: ke(S(), Xe).optional() });
var g9 = rt.extend({ protocolVersion: S(), capabilities: m9, serverInfo: dA, instructions: S().optional() });
var oS = tr.extend({ method: H("notifications/initialized"), params: er.optional() });
var im = tt.extend({ method: H("ping"), params: zt.optional() });
var h9 = L({ progress: fe(), total: Re(fe()), message: Re(S()) });
var y9 = L({ ...er.shape, ...h9.shape, progressToken: oA });
var sm = tr.extend({ method: H("notifications/progress"), params: y9 });
var b9 = zt.extend({ cursor: iA.optional() });
var Il = tt.extend({ params: b9.optional() });
var Rl = rt.extend({ nextCursor: iA.optional() });
var _9 = gt(["working", "input_required", "completed", "failed", "cancelled"]);
var $l = L({ taskId: S(), status: _9, ttl: we([fe(), Wf()]), createdAt: S(), lastUpdatedAt: S(), pollInterval: Re(fe()), statusMessage: Re(S()) });
var gs = rt.extend({ task: $l });
var v9 = er.merge($l);
var Al = tr.extend({ method: H("notifications/tasks/status"), params: v9 });
var am = tt.extend({ method: H("tasks/get"), params: zt.extend({ taskId: S() }) });
var cm = rt.merge($l);
var lm = tt.extend({ method: H("tasks/result"), params: zt.extend({ taskId: S() }) });
var Qxe = rt.loose();
var um = Il.extend({ method: H("tasks/list") });
var dm = Rl.extend({ tasks: ie($l) });
var pm = tt.extend({ method: H("tasks/cancel"), params: zt.extend({ taskId: S() }) });
var pA = rt.merge($l);
var fA = L({ uri: S(), mimeType: Re(S()), _meta: ke(S(), Ae()).optional() });
var mA = fA.extend({ text: S() });
var iS = S().refine((e) => {
  try {
    return atob(e), true;
  } catch {
    return false;
  }
}, { message: "Invalid Base64 string" });
var gA = fA.extend({ blob: iS });
var Ol = gt(["user", "assistant"]);
var hs = L({ audience: ie(Ol).optional(), priority: fe().min(0).max(1).optional(), lastModified: ds.datetime({ offset: true }).optional() });
var hA = L({ ...ms.shape, ...Tl.shape, uri: S(), description: Re(S()), mimeType: Re(S()), size: Re(fe()), annotations: hs.optional(), _meta: Re(lt({})) });
var S9 = L({ ...ms.shape, ...Tl.shape, uriTemplate: S(), description: Re(S()), mimeType: Re(S()), annotations: hs.optional(), _meta: Re(lt({})) });
var fm = Il.extend({ method: H("resources/list") });
var x9 = Rl.extend({ resources: ie(hA) });
var mm = Il.extend({ method: H("resources/templates/list") });
var w9 = Rl.extend({ resourceTemplates: ie(S9) });
var sS = zt.extend({ uri: S() });
var k9 = sS;
var gm = tt.extend({ method: H("resources/read"), params: k9 });
var E9 = rt.extend({ contents: ie(we([mA, gA])) });
var P9 = tr.extend({ method: H("notifications/resources/list_changed"), params: er.optional() });
var T9 = sS;
var I9 = tt.extend({ method: H("resources/subscribe"), params: T9 });
var R9 = sS;
var $9 = tt.extend({ method: H("resources/unsubscribe"), params: R9 });
var A9 = er.extend({ uri: S() });
var O9 = tr.extend({ method: H("notifications/resources/updated"), params: A9 });
var C9 = L({ name: S(), description: Re(S()), required: Re(We()) });
var M9 = L({ ...ms.shape, ...Tl.shape, description: Re(S()), arguments: Re(ie(C9)), _meta: Re(lt({})) });
var hm = Il.extend({ method: H("prompts/list") });
var D9 = Rl.extend({ prompts: ie(M9) });
var N9 = zt.extend({ name: S(), arguments: ke(S(), S()).optional() });
var ym = tt.extend({ method: H("prompts/get"), params: N9 });
var aS = L({ type: H("text"), text: S(), annotations: hs.optional(), _meta: ke(S(), Ae()).optional() });
var cS = L({ type: H("image"), data: iS, mimeType: S(), annotations: hs.optional(), _meta: ke(S(), Ae()).optional() });
var lS = L({ type: H("audio"), data: iS, mimeType: S(), annotations: hs.optional(), _meta: ke(S(), Ae()).optional() });
var j9 = L({ type: H("tool_use"), name: S(), id: S(), input: ke(S(), Ae()), _meta: ke(S(), Ae()).optional() });
var U9 = L({ type: H("resource"), resource: we([mA, gA]), annotations: hs.optional(), _meta: ke(S(), Ae()).optional() });
var z9 = hA.extend({ type: H("resource_link") });
var uS = we([aS, cS, lS, z9, U9]);
var L9 = L({ role: Ol, content: uS });
var F9 = rt.extend({ description: S().optional(), messages: ie(L9) });
var H9 = tr.extend({ method: H("notifications/prompts/list_changed"), params: er.optional() });
var B9 = L({ title: S().optional(), readOnlyHint: We().optional(), destructiveHint: We().optional(), idempotentHint: We().optional(), openWorldHint: We().optional() });
var q9 = L({ taskSupport: gt(["required", "optional", "forbidden"]).optional() });
var yA = L({ ...ms.shape, ...Tl.shape, description: S().optional(), inputSchema: L({ type: H("object"), properties: ke(S(), Xe).optional(), required: ie(S()).optional() }).catchall(Ae()), outputSchema: L({ type: H("object"), properties: ke(S(), Xe).optional(), required: ie(S()).optional() }).catchall(Ae()).optional(), annotations: B9.optional(), execution: q9.optional(), _meta: ke(S(), Ae()).optional() });
var bm = Il.extend({ method: H("tools/list") });
var V9 = Rl.extend({ tools: ie(yA) });
var _m = rt.extend({ content: ie(uS).default([]), structuredContent: ke(S(), Ae()).optional(), isError: We().optional() });
var ewe = _m.or(rt.extend({ toolResult: Ae() }));
var Z9 = El.extend({ name: S(), arguments: ke(S(), Ae()).optional() });
var ys = tt.extend({ method: H("tools/call"), params: Z9 });
var W9 = tr.extend({ method: H("notifications/tools/list_changed"), params: er.optional() });
var twe = L({ autoRefresh: We().default(true), debounceMs: fe().int().nonnegative().default(300) });
var Cl = gt(["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"]);
var K9 = zt.extend({ level: Cl });
var dS = tt.extend({ method: H("logging/setLevel"), params: K9 });
var G9 = er.extend({ level: Cl, logger: S().optional(), data: Ae() });
var J9 = tr.extend({ method: H("notifications/message"), params: G9 });
var X9 = L({ name: S().optional() });
var Y9 = L({ hints: ie(X9).optional(), costPriority: fe().min(0).max(1).optional(), speedPriority: fe().min(0).max(1).optional(), intelligencePriority: fe().min(0).max(1).optional() });
var Q9 = L({ mode: gt(["auto", "required", "none"]).optional() });
var eG = L({ type: H("tool_result"), toolUseId: S().describe("The unique identifier for the corresponding tool call."), content: ie(uS).default([]), structuredContent: L({}).loose().optional(), isError: We().optional(), _meta: ke(S(), Ae()).optional() });
var tG = Xf("type", [aS, cS, lS]);
var em = Xf("type", [aS, cS, lS, j9, eG]);
var rG = L({ role: Ol, content: we([em, ie(em)]), _meta: ke(S(), Ae()).optional() });
var nG = El.extend({ messages: ie(rG), modelPreferences: Y9.optional(), systemPrompt: S().optional(), includeContext: gt(["none", "thisServer", "allServers"]).optional(), temperature: fe().optional(), maxTokens: fe().int(), stopSequences: ie(S()).optional(), metadata: Xe.optional(), tools: ie(yA).optional(), toolChoice: Q9.optional() });
var oG = tt.extend({ method: H("sampling/createMessage"), params: nG });
var Ml = rt.extend({ model: S(), stopReason: Re(gt(["endTurn", "stopSequence", "maxTokens"]).or(S())), role: Ol, content: tG });
var pS = rt.extend({ model: S(), stopReason: Re(gt(["endTurn", "stopSequence", "maxTokens", "toolUse"]).or(S())), role: Ol, content: we([em, ie(em)]) });
var iG = L({ type: H("boolean"), title: S().optional(), description: S().optional(), default: We().optional() });
var sG = L({ type: H("string"), title: S().optional(), description: S().optional(), minLength: fe().optional(), maxLength: fe().optional(), format: gt(["email", "uri", "date", "date-time"]).optional(), default: S().optional() });
var aG = L({ type: gt(["number", "integer"]), title: S().optional(), description: S().optional(), minimum: fe().optional(), maximum: fe().optional(), default: fe().optional() });
var cG = L({ type: H("string"), title: S().optional(), description: S().optional(), enum: ie(S()), default: S().optional() });
var lG = L({ type: H("string"), title: S().optional(), description: S().optional(), oneOf: ie(L({ const: S(), title: S() })), default: S().optional() });
var uG = L({ type: H("string"), title: S().optional(), description: S().optional(), enum: ie(S()), enumNames: ie(S()).optional(), default: S().optional() });
var dG = we([cG, lG]);
var pG = L({ type: H("array"), title: S().optional(), description: S().optional(), minItems: fe().optional(), maxItems: fe().optional(), items: L({ type: H("string"), enum: ie(S()) }), default: ie(S()).optional() });
var fG = L({ type: H("array"), title: S().optional(), description: S().optional(), minItems: fe().optional(), maxItems: fe().optional(), items: L({ anyOf: ie(L({ const: S(), title: S() })) }), default: ie(S()).optional() });
var mG = we([pG, fG]);
var gG = we([uG, dG, mG]);
var hG = we([gG, iG, sG, aG]);
var yG = El.extend({ mode: H("form").optional(), message: S(), requestedSchema: L({ type: H("object"), properties: ke(S(), hG), required: ie(S()).optional() }) });
var bG = El.extend({ mode: H("url"), message: S(), elicitationId: S(), url: S().url() });
var _G = we([yG, bG]);
var vG = tt.extend({ method: H("elicitation/create"), params: _G });
var SG = er.extend({ elicitationId: S() });
var xG = tr.extend({ method: H("notifications/elicitation/complete"), params: SG });
var bs = rt.extend({ action: gt(["accept", "decline", "cancel"]), content: Qf((e) => e === null ? void 0 : e, ke(S(), we([S(), fe(), We(), ie(S())])).optional()) });
var wG = L({ type: H("ref/resource"), uri: S() });
var kG = L({ type: H("ref/prompt"), name: S() });
var EG = zt.extend({ ref: we([kG, wG]), argument: L({ name: S(), value: S() }), context: L({ arguments: ke(S(), S()).optional() }).optional() });
var vm = tt.extend({ method: H("completion/complete"), params: EG });
var PG = rt.extend({ completion: lt({ values: ie(S()).max(100), total: Re(fe().int()), hasMore: Re(We()) }) });
var TG = L({ uri: S().startsWith("file://"), name: S().optional(), _meta: ke(S(), Ae()).optional() });
var IG = tt.extend({ method: H("roots/list"), params: zt.optional() });
var fS = rt.extend({ roots: ie(TG) });
var RG = tr.extend({ method: H("notifications/roots/list_changed"), params: er.optional() });
var rwe = we([im, nS, vm, dS, ym, hm, fm, mm, gm, I9, $9, ys, bm, am, lm, um, pm]);
var nwe = we([om, sm, oS, RG, Al]);
var owe = we([nm, Ml, pS, bs, fS, cm, dm, gs]);
var iwe = we([im, oG, vG, IG, am, lm, um, pm]);
var swe = we([om, sm, J9, O9, P9, W9, H9, Al, xG]);
var awe = we([nm, g9, PG, F9, D9, x9, w9, E9, _m, V9, cm, dm, gs]);
var xA = Symbol("Let zodToJsonSchema decide on which parser to use");
var OG = new Set("ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvxyz0123456789");
var NN = Og(yx(), 1);
var jN = Og(DN(), 1);
var FN = Symbol.for("mcp.completable");
var LN;
(function(e) {
  e.Completable = "McpCompletable";
})(LN || (LN = {}));
function T(e) {
  let t;
  return () => t ??= e();
}
var hee = T(() => l.object({ session_id: l.string(), ws_url: l.string(), work_dir: l.string().optional(), session_key: l.string().optional() }));
var JN;
(function(e) {
  e[e.lineFeed = 10] = "lineFeed", e[e.carriageReturn = 13] = "carriageReturn", e[e.space = 32] = "space", e[e._0 = 48] = "_0", e[e._1 = 49] = "_1", e[e._2 = 50] = "_2", e[e._3 = 51] = "_3", e[e._4 = 52] = "_4", e[e._5 = 53] = "_5", e[e._6 = 54] = "_6", e[e._7 = 55] = "_7", e[e._8 = 56] = "_8", e[e._9 = 57] = "_9", e[e.a = 97] = "a", e[e.b = 98] = "b", e[e.c = 99] = "c", e[e.d = 100] = "d", e[e.e = 101] = "e", e[e.f = 102] = "f", e[e.g = 103] = "g", e[e.h = 104] = "h", e[e.i = 105] = "i", e[e.j = 106] = "j", e[e.k = 107] = "k", e[e.l = 108] = "l", e[e.m = 109] = "m", e[e.n = 110] = "n", e[e.o = 111] = "o", e[e.p = 112] = "p", e[e.q = 113] = "q", e[e.r = 114] = "r", e[e.s = 115] = "s", e[e.t = 116] = "t", e[e.u = 117] = "u", e[e.v = 118] = "v", e[e.w = 119] = "w", e[e.x = 120] = "x", e[e.y = 121] = "y", e[e.z = 122] = "z", e[e.A = 65] = "A", e[e.B = 66] = "B", e[e.C = 67] = "C", e[e.D = 68] = "D", e[e.E = 69] = "E", e[e.F = 70] = "F", e[e.G = 71] = "G", e[e.H = 72] = "H", e[e.I = 73] = "I", e[e.J = 74] = "J", e[e.K = 75] = "K", e[e.L = 76] = "L", e[e.M = 77] = "M", e[e.N = 78] = "N", e[e.O = 79] = "O", e[e.P = 80] = "P", e[e.Q = 81] = "Q", e[e.R = 82] = "R", e[e.S = 83] = "S", e[e.T = 84] = "T", e[e.U = 85] = "U", e[e.V = 86] = "V", e[e.W = 87] = "W", e[e.X = 88] = "X", e[e.Y = 89] = "Y", e[e.Z = 90] = "Z", e[e.asterisk = 42] = "asterisk", e[e.backslash = 92] = "backslash", e[e.closeBrace = 125] = "closeBrace", e[e.closeBracket = 93] = "closeBracket", e[e.colon = 58] = "colon", e[e.comma = 44] = "comma", e[e.dot = 46] = "dot", e[e.doubleQuote = 34] = "doubleQuote", e[e.minus = 45] = "minus", e[e.openBrace = 123] = "openBrace", e[e.openBracket = 91] = "openBracket", e[e.plus = 43] = "plus", e[e.slash = 47] = "slash", e[e.formFeed = 12] = "formFeed", e[e.tab = 9] = "tab";
})(JN || (JN = {}));
var Pee = Array(20).fill(0).map((e, t) => " ".repeat(t));
var Tee = { " ": { "\n": Array(200).fill(0).map((e, t) => `
` + " ".repeat(t)), "\r": Array(200).fill(0).map((e, t) => "\r" + " ".repeat(t)), "\r\n": Array(200).fill(0).map((e, t) => `\r
` + " ".repeat(t)) }, "	": { "\n": Array(200).fill(0).map((e, t) => `
` + "	".repeat(t)), "\r": Array(200).fill(0).map((e, t) => "\r" + "	".repeat(t)), "\r\n": Array(200).fill(0).map((e, t) => `\r
` + "	".repeat(t)) } };
var YN;
(function(e) {
  e.DEFAULT = { allowTrailingComma: false };
})(YN || (YN = {}));
var QN;
(function(e) {
  e[e.None = 0] = "None", e[e.UnexpectedEndOfComment = 1] = "UnexpectedEndOfComment", e[e.UnexpectedEndOfString = 2] = "UnexpectedEndOfString", e[e.UnexpectedEndOfNumber = 3] = "UnexpectedEndOfNumber", e[e.InvalidUnicode = 4] = "InvalidUnicode", e[e.InvalidEscapeCharacter = 5] = "InvalidEscapeCharacter", e[e.InvalidCharacter = 6] = "InvalidCharacter";
})(QN || (QN = {}));
var ej;
(function(e) {
  e[e.OpenBraceToken = 1] = "OpenBraceToken", e[e.CloseBraceToken = 2] = "CloseBraceToken", e[e.OpenBracketToken = 3] = "OpenBracketToken", e[e.CloseBracketToken = 4] = "CloseBracketToken", e[e.CommaToken = 5] = "CommaToken", e[e.ColonToken = 6] = "ColonToken", e[e.NullKeyword = 7] = "NullKeyword", e[e.TrueKeyword = 8] = "TrueKeyword", e[e.FalseKeyword = 9] = "FalseKeyword", e[e.StringLiteral = 10] = "StringLiteral", e[e.NumericLiteral = 11] = "NumericLiteral", e[e.LineCommentTrivia = 12] = "LineCommentTrivia", e[e.BlockCommentTrivia = 13] = "BlockCommentTrivia", e[e.LineBreakTrivia = 14] = "LineBreakTrivia", e[e.Trivia = 15] = "Trivia", e[e.Unknown = 16] = "Unknown", e[e.EOF = 17] = "EOF";
})(ej || (ej = {}));
var tj;
(function(e) {
  e[e.InvalidSymbol = 1] = "InvalidSymbol", e[e.InvalidNumberFormat = 2] = "InvalidNumberFormat", e[e.PropertyNameExpected = 3] = "PropertyNameExpected", e[e.ValueExpected = 4] = "ValueExpected", e[e.ColonExpected = 5] = "ColonExpected", e[e.CommaExpected = 6] = "CommaExpected", e[e.CloseBraceExpected = 7] = "CloseBraceExpected", e[e.CloseBracketExpected = 8] = "CloseBracketExpected", e[e.EndOfFileExpected = 9] = "EndOfFileExpected", e[e.InvalidCommentToken = 10] = "InvalidCommentToken", e[e.UnexpectedEndOfComment = 11] = "UnexpectedEndOfComment", e[e.UnexpectedEndOfString = 12] = "UnexpectedEndOfString", e[e.UnexpectedEndOfNumber = 13] = "UnexpectedEndOfNumber", e[e.InvalidUnicode = 14] = "InvalidUnicode", e[e.InvalidEscapeCharacter = 15] = "InvalidEscapeCharacter", e[e.InvalidCharacter = 16] = "InvalidCharacter";
})(tj || (tj = {}));
function ag(e) {
  return e.startsWith("\uFEFF") ? e.slice(1) : e;
}
var Kn = rj.homedir();
var Nx = rj.tmpdir();
var { env: Os } = Dx;
var Mee = (e) => {
  let t = Ne.join(Kn, "Library");
  return { data: Ne.join(t, "Application Support", e), config: Ne.join(t, "Preferences", e), cache: Ne.join(t, "Caches", e), log: Ne.join(t, "Logs", e), temp: Ne.join(Nx, e) };
};
var Dee = (e) => {
  let t = Os.APPDATA || Ne.join(Kn, "AppData", "Roaming"), r = Os.LOCALAPPDATA || Ne.join(Kn, "AppData", "Local");
  return { data: Ne.join(r, e, "Data"), config: Ne.join(t, e, "Config"), cache: Ne.join(r, e, "Cache"), log: Ne.join(r, e, "Log"), temp: Ne.join(Nx, e) };
};
var Nee = (e) => {
  let t = Ne.basename(Kn);
  return { data: Ne.join(Os.XDG_DATA_HOME || Ne.join(Kn, ".local", "share"), e), config: Ne.join(Os.XDG_CONFIG_HOME || Ne.join(Kn, ".config"), e), cache: Ne.join(Os.XDG_CACHE_HOME || Ne.join(Kn, ".cache"), e), log: Ne.join(Os.XDG_STATE_HOME || Ne.join(Kn, ".local", "state"), e), temp: Ne.join(Nx, t, e) };
};
function jx(e, { suffix: t = "nodejs" } = {}) {
  if (typeof e !== "string") throw TypeError(`Expected a string, got ${typeof e}`);
  if (t) e += `-${t}`;
  if (Dx.platform === "darwin") return Mee(e);
  if (Dx.platform === "win32") return Dee(e);
  return Nee(e);
}
var h0e = jx("claude-cli");
function jee() {
  if (process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) return "essential-traffic";
  if (process.env.DISABLE_TELEMETRY) return "no-telemetry";
  if (Ee(process.env.DO_NOT_TRACK)) return "no-telemetry";
  return "default";
}
function nj() {
  return jee() === "essential-traffic";
}
var Uee = 100;
var Ux = [];
function zee(e) {
  if (Ux.length >= Uee) Ux.shift();
  Ux.push(e);
}
var Lee = [];
var oj = null;
var F0e = Ce(() => process.argv.includes("--hard-fail"));
function cg(e) {
  let t = Pr(e);
  try {
    if (Ee(process.env.CLAUDE_CODE_USE_BEDROCK) || Ee(process.env.CLAUDE_CODE_USE_VERTEX) || Ee(process.env.CLAUDE_CODE_USE_FOUNDRY) || Ee(process.env.CLAUDE_CODE_USE_ANTHROPIC_AWS) || Ee(process.env.CLAUDE_CODE_USE_MANTLE) || process.env.DISABLE_ERROR_REPORTING || nj()) return;
    let o = { error: t.stack || t.message, timestamp: (/* @__PURE__ */ new Date()).toISOString() };
    if (zee(o), oj === null) {
      Lee.push({ type: "error", error: t });
      return;
    }
    oj.logError(t);
  } catch {
  }
}
var Cs = typeof performance === "object" && performance && typeof performance.now === "function" ? performance : Date;
var sj = /* @__PURE__ */ new Set();
var zx = typeof process === "object" && !!process ? process : {};
var aj = (e, t, r, o) => {
  typeof zx.emitWarning === "function" ? zx.emitWarning(e, t, r, o) : console.error(`[${r}] ${t}: ${e}`);
};
var lg = globalThis.AbortController;
var ij = globalThis.AbortSignal;
if (typeof lg > "u") {
  ij = class {
    onabort;
    _onabort = [];
    reason;
    aborted = false;
    addEventListener(o, n) {
      this._onabort.push(n);
    }
  }, lg = class {
    constructor() {
      t();
    }
    signal = new ij();
    abort(o) {
      if (this.signal.aborted) return;
      this.signal.reason = o, this.signal.aborted = true;
      for (let n of this.signal._onabort) n(o);
      this.signal.onabort?.(o);
    }
  };
  let e = zx.env?.LRU_CACHE_IGNORE_AC_WARNING !== "1", t = () => {
    if (!e) return;
    e = false, aj("AbortController is not defined. If using lru-cache in node 14, load an AbortController polyfill from the `node-abort-controller` package. A minimal polyfill is provided for use by LRUCache.fetch(), but it should not be relied upon in other contexts (eg, passing it to other APIs that use AbortController/AbortSignal might have undesirable effects). You may disable this with LRU_CACHE_IGNORE_AC_WARNING=1 in the env.", "NO_ABORT_CONTROLLER", "ENOTSUP", t);
  };
}
var Fee = (e) => !sj.has(e);
var B0e = Symbol("type");
var Gn = (e) => e && e === Math.floor(e) && e > 0 && isFinite(e);
var cj = (e) => !Gn(e) ? null : e <= Math.pow(2, 8) ? Uint8Array : e <= Math.pow(2, 16) ? Uint16Array : e <= Math.pow(2, 32) ? Uint32Array : e <= Number.MAX_SAFE_INTEGER ? au : null;
var au = class extends Array {
  constructor(e) {
    super(e);
    this.fill(0);
  }
};
var Ms = class _Ms {
  heap;
  length;
  static #n = false;
  static create(e) {
    let t = cj(e);
    if (!t) return [];
    _Ms.#n = true;
    let r = new _Ms(e, t);
    return _Ms.#n = false, r;
  }
  constructor(e, t) {
    if (!_Ms.#n) throw TypeError("instantiate Stack using Stack.create(n)");
    this.heap = new t(e), this.length = 0;
  }
  push(e) {
    this.heap[this.length++] = e;
  }
  pop() {
    return this.heap[--this.length];
  }
};
var ug = class _ug {
  #n;
  #d;
  #g;
  #h;
  #$;
  #A;
  ttl;
  ttlResolution;
  ttlAutopurge;
  updateAgeOnGet;
  updateAgeOnHas;
  allowStale;
  noDisposeOnSet;
  noUpdateTTL;
  maxEntrySize;
  sizeCalculation;
  noDeleteOnFetchRejection;
  noDeleteOnStaleGet;
  allowStaleOnFetchAbort;
  allowStaleOnFetchRejection;
  ignoreFetchAbort;
  #i;
  #y;
  #o;
  #r;
  #e;
  #l;
  #p;
  #c;
  #s;
  #b;
  #a;
  #_;
  #v;
  #f;
  #S;
  #P;
  #u;
  static unsafeExposeInternals(e) {
    return { starts: e.#v, ttls: e.#f, sizes: e.#_, keyMap: e.#o, keyList: e.#r, valList: e.#e, next: e.#l, prev: e.#p, get head() {
      return e.#c;
    }, get tail() {
      return e.#s;
    }, free: e.#b, isBackgroundFetch: (t) => e.#t(t), backgroundFetch: (t, r, o, n) => e.#M(t, r, o, n), moveToTail: (t) => e.#R(t), indexes: (t) => e.#x(t), rindexes: (t) => e.#w(t), isStale: (t) => e.#m(t) };
  }
  get max() {
    return this.#n;
  }
  get maxSize() {
    return this.#d;
  }
  get calculatedSize() {
    return this.#y;
  }
  get size() {
    return this.#i;
  }
  get fetchMethod() {
    return this.#$;
  }
  get memoMethod() {
    return this.#A;
  }
  get dispose() {
    return this.#g;
  }
  get disposeAfter() {
    return this.#h;
  }
  constructor(e) {
    let { max: t = 0, ttl: r, ttlResolution: o = 1, ttlAutopurge: n, updateAgeOnGet: i, updateAgeOnHas: s, allowStale: a, dispose: c, disposeAfter: u, noDisposeOnSet: d, noUpdateTTL: p, maxSize: f = 0, maxEntrySize: m = 0, sizeCalculation: g, fetchMethod: h, memoMethod: y, noDeleteOnFetchRejection: v, noDeleteOnStaleGet: w, allowStaleOnFetchRejection: x, allowStaleOnFetchAbort: $, ignoreFetchAbort: U } = e;
    if (t !== 0 && !Gn(t)) throw TypeError("max option must be a nonnegative integer");
    let se = t ? cj(t) : Array;
    if (!se) throw Error("invalid max value: " + t);
    if (this.#n = t, this.#d = f, this.maxEntrySize = m || this.#d, this.sizeCalculation = g, this.sizeCalculation) {
      if (!this.#d && !this.maxEntrySize) throw TypeError("cannot set sizeCalculation without setting maxSize or maxEntrySize");
      if (typeof this.sizeCalculation !== "function") throw TypeError("sizeCalculation set to non-function");
    }
    if (y !== void 0 && typeof y !== "function") throw TypeError("memoMethod must be a function if defined");
    if (this.#A = y, h !== void 0 && typeof h !== "function") throw TypeError("fetchMethod must be a function if specified");
    if (this.#$ = h, this.#P = !!h, this.#o = /* @__PURE__ */ new Map(), this.#r = Array(t).fill(void 0), this.#e = Array(t).fill(void 0), this.#l = new se(t), this.#p = new se(t), this.#c = 0, this.#s = 0, this.#b = Ms.create(t), this.#i = 0, this.#y = 0, typeof c === "function") this.#g = c;
    if (typeof u === "function") this.#h = u, this.#a = [];
    else this.#h = void 0, this.#a = void 0;
    if (this.#S = !!this.#g, this.#u = !!this.#h, this.noDisposeOnSet = !!d, this.noUpdateTTL = !!p, this.noDeleteOnFetchRejection = !!v, this.allowStaleOnFetchRejection = !!x, this.allowStaleOnFetchAbort = !!$, this.ignoreFetchAbort = !!U, this.maxEntrySize !== 0) {
      if (this.#d !== 0) {
        if (!Gn(this.#d)) throw TypeError("maxSize must be a positive integer if specified");
      }
      if (!Gn(this.maxEntrySize)) throw TypeError("maxEntrySize must be a positive integer if specified");
      this.#F();
    }
    if (this.allowStale = !!a, this.noDeleteOnStaleGet = !!w, this.updateAgeOnGet = !!i, this.updateAgeOnHas = !!s, this.ttlResolution = Gn(o) || o === 0 ? o : 1, this.ttlAutopurge = !!n, this.ttl = r || 0, this.ttl) {
      if (!Gn(this.ttl)) throw TypeError("ttl must be a positive integer if specified");
      this.#D();
    }
    if (this.#n === 0 && this.ttl === 0 && this.#d === 0) throw TypeError("At least one of max, maxSize, or ttl is required");
    if (!this.ttlAutopurge && !this.#n && !this.#d) {
      if (Fee("LRU_CACHE_UNBOUNDED")) sj.add("LRU_CACHE_UNBOUNDED"), aj("TTL caching without ttlAutopurge, max, or maxSize can result in unbounded memory consumption.", "UnboundedCacheWarning", "LRU_CACHE_UNBOUNDED", _ug);
    }
  }
  getRemainingTTL(e) {
    return this.#o.has(e) ? 1 / 0 : 0;
  }
  #D() {
    let e = new au(this.#n), t = new au(this.#n);
    this.#f = e, this.#v = t, this.#N = (n, i, s = Cs.now()) => {
      if (t[n] = i !== 0 ? s : 0, e[n] = i, i !== 0 && this.ttlAutopurge) {
        let a = setTimeout(() => {
          if (this.#m(n)) this.#k(this.#r[n], "expire");
        }, i + 1);
        if (a.unref) a.unref();
      }
    }, this.#T = (n) => {
      t[n] = e[n] !== 0 ? Cs.now() : 0;
    }, this.#E = (n, i) => {
      if (e[i]) {
        let s = e[i], a = t[i];
        if (!s || !a) return;
        n.ttl = s, n.start = a, n.now = r || o();
        let c = n.now - a;
        n.remainingTTL = s - c;
      }
    };
    let r = 0, o = () => {
      let n = Cs.now();
      if (this.ttlResolution > 0) {
        r = n;
        let i = setTimeout(() => r = 0, this.ttlResolution);
        if (i.unref) i.unref();
      }
      return n;
    };
    this.getRemainingTTL = (n) => {
      let i = this.#o.get(n);
      if (i === void 0) return 0;
      let s = e[i], a = t[i];
      if (!s || !a) return 1 / 0;
      let c = (r || o()) - a;
      return s - c;
    }, this.#m = (n) => {
      let i = t[n], s = e[n];
      return !!s && !!i && (r || o()) - i > s;
    };
  }
  #T = () => {
  };
  #E = () => {
  };
  #N = () => {
  };
  #m = () => false;
  #F() {
    let e = new au(this.#n);
    this.#y = 0, this.#_ = e, this.#I = (t) => {
      this.#y -= e[t], e[t] = 0;
    }, this.#j = (t, r, o, n) => {
      if (this.#t(r)) return 0;
      if (!Gn(o)) if (n) {
        if (typeof n !== "function") throw TypeError("sizeCalculation must be a function");
        if (o = n(r, t), !Gn(o)) throw TypeError("sizeCalculation return invalid (expect positive integer)");
      } else throw TypeError("invalid size value (must be positive integer). When maxSize or maxEntrySize is used, sizeCalculation or size must be set.");
      return o;
    }, this.#O = (t, r, o) => {
      if (e[t] = r, this.#d) {
        let n = this.#d - e[t];
        while (this.#y > n) this.#C(true);
      }
      if (this.#y += e[t], o) o.entrySize = r, o.totalCalculatedSize = this.#y;
    };
  }
  #I = (e) => {
  };
  #O = (e, t, r) => {
  };
  #j = (e, t, r, o) => {
    if (r || o) throw TypeError("cannot set size without setting maxSize or maxEntrySize on cache");
    return 0;
  };
  *#x({ allowStale: e = this.allowStale } = {}) {
    if (this.#i) for (let t = this.#s; ; ) {
      if (!this.#U(t)) break;
      if (e || !this.#m(t)) yield t;
      if (t === this.#c) break;
      else t = this.#p[t];
    }
  }
  *#w({ allowStale: e = this.allowStale } = {}) {
    if (this.#i) for (let t = this.#c; ; ) {
      if (!this.#U(t)) break;
      if (e || !this.#m(t)) yield t;
      if (t === this.#s) break;
      else t = this.#l[t];
    }
  }
  #U(e) {
    return e !== void 0 && this.#o.get(this.#r[e]) === e;
  }
  *entries() {
    for (let e of this.#x()) if (this.#e[e] !== void 0 && this.#r[e] !== void 0 && !this.#t(this.#e[e])) yield [this.#r[e], this.#e[e]];
  }
  *rentries() {
    for (let e of this.#w()) if (this.#e[e] !== void 0 && this.#r[e] !== void 0 && !this.#t(this.#e[e])) yield [this.#r[e], this.#e[e]];
  }
  *keys() {
    for (let e of this.#x()) {
      let t = this.#r[e];
      if (t !== void 0 && !this.#t(this.#e[e])) yield t;
    }
  }
  *rkeys() {
    for (let e of this.#w()) {
      let t = this.#r[e];
      if (t !== void 0 && !this.#t(this.#e[e])) yield t;
    }
  }
  *values() {
    for (let e of this.#x()) if (this.#e[e] !== void 0 && !this.#t(this.#e[e])) yield this.#e[e];
  }
  *rvalues() {
    for (let e of this.#w()) if (this.#e[e] !== void 0 && !this.#t(this.#e[e])) yield this.#e[e];
  }
  [Symbol.iterator]() {
    return this.entries();
  }
  [Symbol.toStringTag] = "LRUCache";
  find(e, t = {}) {
    for (let r of this.#x()) {
      let o = this.#e[r], n = this.#t(o) ? o.__staleWhileFetching : o;
      if (n === void 0) continue;
      if (e(n, this.#r[r], this)) return this.get(this.#r[r], t);
    }
  }
  forEach(e, t = this) {
    for (let r of this.#x()) {
      let o = this.#e[r], n = this.#t(o) ? o.__staleWhileFetching : o;
      if (n === void 0) continue;
      e.call(t, n, this.#r[r], this);
    }
  }
  rforEach(e, t = this) {
    for (let r of this.#w()) {
      let o = this.#e[r], n = this.#t(o) ? o.__staleWhileFetching : o;
      if (n === void 0) continue;
      e.call(t, n, this.#r[r], this);
    }
  }
  purgeStale() {
    let e = false;
    for (let t of this.#w({ allowStale: true })) if (this.#m(t)) this.#k(this.#r[t], "expire"), e = true;
    return e;
  }
  info(e) {
    let t = this.#o.get(e);
    if (t === void 0) return;
    let r = this.#e[t], o = this.#t(r) ? r.__staleWhileFetching : r;
    if (o === void 0) return;
    let n = { value: o };
    if (this.#f && this.#v) {
      let i = this.#f[t], s = this.#v[t];
      if (i && s) {
        let a = i - (Cs.now() - s);
        n.ttl = a, n.start = Date.now();
      }
    }
    if (this.#_) n.size = this.#_[t];
    return n;
  }
  dump() {
    let e = [];
    for (let t of this.#x({ allowStale: true })) {
      let r = this.#r[t], o = this.#e[t], n = this.#t(o) ? o.__staleWhileFetching : o;
      if (n === void 0 || r === void 0) continue;
      let i = { value: n };
      if (this.#f && this.#v) {
        i.ttl = this.#f[t];
        let s = Cs.now() - this.#v[t];
        i.start = Math.floor(Date.now() - s);
      }
      if (this.#_) i.size = this.#_[t];
      e.unshift([r, i]);
    }
    return e;
  }
  load(e) {
    this.clear();
    for (let [t, r] of e) {
      if (r.start) {
        let o = Date.now() - r.start;
        r.start = Cs.now() - o;
      }
      this.set(t, r.value, r);
    }
  }
  set(e, t, r = {}) {
    if (t === void 0) return this.delete(e), this;
    let { ttl: o = this.ttl, start: n, noDisposeOnSet: i = this.noDisposeOnSet, sizeCalculation: s = this.sizeCalculation, status: a } = r, { noUpdateTTL: c = this.noUpdateTTL } = r, u = this.#j(e, t, r.size || 0, s);
    if (this.maxEntrySize && u > this.maxEntrySize) {
      if (a) a.set = "miss", a.maxEntrySizeExceeded = true;
      return this.#k(e, "set"), this;
    }
    let d = this.#i === 0 ? void 0 : this.#o.get(e);
    if (d === void 0) {
      if (d = this.#i === 0 ? this.#s : this.#b.length !== 0 ? this.#b.pop() : this.#i === this.#n ? this.#C(false) : this.#i, this.#r[d] = e, this.#e[d] = t, this.#o.set(e, d), this.#l[this.#s] = d, this.#p[d] = this.#s, this.#s = d, this.#i++, this.#O(d, u, a), a) a.set = "add";
      c = false;
    } else {
      this.#R(d);
      let p = this.#e[d];
      if (t !== p) {
        if (this.#P && this.#t(p)) {
          p.__abortController.abort(Error("replaced"));
          let { __staleWhileFetching: f } = p;
          if (f !== void 0 && !i) {
            if (this.#S) this.#g?.(f, e, "set");
            if (this.#u) this.#a?.push([f, e, "set"]);
          }
        } else if (!i) {
          if (this.#S) this.#g?.(p, e, "set");
          if (this.#u) this.#a?.push([p, e, "set"]);
        }
        if (this.#I(d), this.#O(d, u, a), this.#e[d] = t, a) {
          a.set = "replace";
          let f = p && this.#t(p) ? p.__staleWhileFetching : p;
          if (f !== void 0) a.oldValue = f;
        }
      } else if (a) a.set = "update";
    }
    if (o !== 0 && !this.#f) this.#D();
    if (this.#f) {
      if (!c) this.#N(d, o, n);
      if (a) this.#E(a, d);
    }
    if (!i && this.#u && this.#a) {
      let p = this.#a, f;
      while (f = p?.shift()) this.#h?.(...f);
    }
    return this;
  }
  pop() {
    try {
      while (this.#i) {
        let e = this.#e[this.#c];
        if (this.#C(true), this.#t(e)) {
          if (e.__staleWhileFetching) return e.__staleWhileFetching;
        } else if (e !== void 0) return e;
      }
    } finally {
      if (this.#u && this.#a) {
        let e = this.#a, t;
        while (t = e?.shift()) this.#h?.(...t);
      }
    }
  }
  #C(e) {
    let t = this.#c, r = this.#r[t], o = this.#e[t];
    if (this.#P && this.#t(o)) o.__abortController.abort(Error("evicted"));
    else if (this.#S || this.#u) {
      if (this.#S) this.#g?.(o, r, "evict");
      if (this.#u) this.#a?.push([o, r, "evict"]);
    }
    if (this.#I(t), e) this.#r[t] = void 0, this.#e[t] = void 0, this.#b.push(t);
    if (this.#i === 1) this.#c = this.#s = 0, this.#b.length = 0;
    else this.#c = this.#l[t];
    return this.#o.delete(r), this.#i--, t;
  }
  has(e, t = {}) {
    let { updateAgeOnHas: r = this.updateAgeOnHas, status: o } = t, n = this.#o.get(e);
    if (n !== void 0) {
      let i = this.#e[n];
      if (this.#t(i) && i.__staleWhileFetching === void 0) return false;
      if (!this.#m(n)) {
        if (r) this.#T(n);
        if (o) o.has = "hit", this.#E(o, n);
        return true;
      } else if (o) o.has = "stale", this.#E(o, n);
    } else if (o) o.has = "miss";
    return false;
  }
  peek(e, t = {}) {
    let { allowStale: r = this.allowStale } = t, o = this.#o.get(e);
    if (o === void 0 || !r && this.#m(o)) return;
    let n = this.#e[o];
    return this.#t(n) ? n.__staleWhileFetching : n;
  }
  #M(e, t, r, o) {
    let n = t === void 0 ? void 0 : this.#e[t];
    if (this.#t(n)) return n;
    let i = new lg(), { signal: s } = r;
    s?.addEventListener("abort", () => i.abort(s.reason), { signal: i.signal });
    let a = { signal: i.signal, options: r, context: o }, c = (g, h = false) => {
      let { aborted: y } = i.signal, v = r.ignoreFetchAbort && g !== void 0;
      if (r.status) if (y && !h) {
        if (r.status.fetchAborted = true, r.status.fetchError = i.signal.reason, v) r.status.fetchAbortIgnored = true;
      } else r.status.fetchResolved = true;
      if (y && !v && !h) return d(i.signal.reason);
      let w = f;
      if (this.#e[t] === f) if (g === void 0) if (w.__staleWhileFetching) this.#e[t] = w.__staleWhileFetching;
      else this.#k(e, "fetch");
      else {
        if (r.status) r.status.fetchUpdated = true;
        this.set(e, g, a.options);
      }
      return g;
    }, u = (g) => {
      if (r.status) r.status.fetchRejected = true, r.status.fetchError = g;
      return d(g);
    }, d = (g) => {
      let { aborted: h } = i.signal, y = h && r.allowStaleOnFetchAbort, v = y || r.allowStaleOnFetchRejection, w = v || r.noDeleteOnFetchRejection, x = f;
      if (this.#e[t] === f) {
        if (!w || x.__staleWhileFetching === void 0) this.#k(e, "fetch");
        else if (!y) this.#e[t] = x.__staleWhileFetching;
      }
      if (v) {
        if (r.status && x.__staleWhileFetching !== void 0) r.status.returnedStale = true;
        return x.__staleWhileFetching;
      } else if (x.__returned === x) throw g;
    }, p = (g, h) => {
      let y = this.#$?.(e, n, a);
      if (y && y instanceof Promise) y.then((v) => g(v === void 0 ? void 0 : v), h);
      i.signal.addEventListener("abort", () => {
        if (!r.ignoreFetchAbort || r.allowStaleOnFetchAbort) {
          if (g(void 0), r.allowStaleOnFetchAbort) g = (v) => c(v, true);
        }
      });
    };
    if (r.status) r.status.fetchDispatched = true;
    let f = new Promise(p).then(c, u), m = Object.assign(f, { __abortController: i, __staleWhileFetching: n, __returned: void 0 });
    if (t === void 0) this.set(e, m, { ...a.options, status: void 0 }), t = this.#o.get(e);
    else this.#e[t] = m;
    return m;
  }
  #t(e) {
    if (!this.#P) return false;
    let t = e;
    return !!t && t instanceof Promise && t.hasOwnProperty("__staleWhileFetching") && t.__abortController instanceof lg;
  }
  async fetch(e, t = {}) {
    let { allowStale: r = this.allowStale, updateAgeOnGet: o = this.updateAgeOnGet, noDeleteOnStaleGet: n = this.noDeleteOnStaleGet, ttl: i = this.ttl, noDisposeOnSet: s = this.noDisposeOnSet, size: a = 0, sizeCalculation: c = this.sizeCalculation, noUpdateTTL: u = this.noUpdateTTL, noDeleteOnFetchRejection: d = this.noDeleteOnFetchRejection, allowStaleOnFetchRejection: p = this.allowStaleOnFetchRejection, ignoreFetchAbort: f = this.ignoreFetchAbort, allowStaleOnFetchAbort: m = this.allowStaleOnFetchAbort, context: g, forceRefresh: h = false, status: y, signal: v } = t;
    if (!this.#P) {
      if (y) y.fetch = "get";
      return this.get(e, { allowStale: r, updateAgeOnGet: o, noDeleteOnStaleGet: n, status: y });
    }
    let w = { allowStale: r, updateAgeOnGet: o, noDeleteOnStaleGet: n, ttl: i, noDisposeOnSet: s, size: a, sizeCalculation: c, noUpdateTTL: u, noDeleteOnFetchRejection: d, allowStaleOnFetchRejection: p, allowStaleOnFetchAbort: m, ignoreFetchAbort: f, status: y, signal: v }, x = this.#o.get(e);
    if (x === void 0) {
      if (y) y.fetch = "miss";
      let $ = this.#M(e, x, w, g);
      return $.__returned = $;
    } else {
      let $ = this.#e[x];
      if (this.#t($)) {
        let Ft = r && $.__staleWhileFetching !== void 0;
        if (y) {
          if (y.fetch = "inflight", Ft) y.returnedStale = true;
        }
        return Ft ? $.__staleWhileFetching : $.__returned = $;
      }
      let U = this.#m(x);
      if (!h && !U) {
        if (y) y.fetch = "hit";
        if (this.#R(x), o) this.#T(x);
        if (y) this.#E(y, x);
        return $;
      }
      let se = this.#M(e, x, w, g), Ye = se.__staleWhileFetching !== void 0 && r;
      if (y) {
        if (y.fetch = U ? "stale" : "refresh", Ye && U) y.returnedStale = true;
      }
      return Ye ? se.__staleWhileFetching : se.__returned = se;
    }
  }
  async forceFetch(e, t = {}) {
    let r = await this.fetch(e, t);
    if (r === void 0) throw Error("fetch() returned undefined");
    return r;
  }
  memo(e, t = {}) {
    let r = this.#A;
    if (!r) throw Error("no memoMethod provided to constructor");
    let { context: o, forceRefresh: n, ...i } = t, s = this.get(e, i);
    if (!n && s !== void 0) return s;
    let a = r(e, s, { options: i, context: o });
    return this.set(e, a, i), a;
  }
  get(e, t = {}) {
    let { allowStale: r = this.allowStale, updateAgeOnGet: o = this.updateAgeOnGet, noDeleteOnStaleGet: n = this.noDeleteOnStaleGet, status: i } = t, s = this.#o.get(e);
    if (s !== void 0) {
      let a = this.#e[s], c = this.#t(a);
      if (i) this.#E(i, s);
      if (this.#m(s)) {
        if (i) i.get = "stale";
        if (!c) {
          if (!n) this.#k(e, "expire");
          if (i && r) i.returnedStale = true;
          return r ? a : void 0;
        } else {
          if (i && r && a.__staleWhileFetching !== void 0) i.returnedStale = true;
          return r ? a.__staleWhileFetching : void 0;
        }
      } else {
        if (i) i.get = "hit";
        if (c) return a.__staleWhileFetching;
        if (this.#R(s), o) this.#T(s);
        return a;
      }
    } else if (i) i.get = "miss";
  }
  #z(e, t) {
    this.#p[t] = e, this.#l[e] = t;
  }
  #R(e) {
    if (e !== this.#s) {
      if (e === this.#c) this.#c = this.#l[e];
      else this.#z(this.#p[e], this.#l[e]);
      this.#z(this.#s, e), this.#s = e;
    }
  }
  delete(e) {
    return this.#k(e, "delete");
  }
  #k(e, t) {
    let r = false;
    if (this.#i !== 0) {
      let o = this.#o.get(e);
      if (o !== void 0) if (r = true, this.#i === 1) this.#L(t);
      else {
        this.#I(o);
        let n = this.#e[o];
        if (this.#t(n)) n.__abortController.abort(Error("deleted"));
        else if (this.#S || this.#u) {
          if (this.#S) this.#g?.(n, e, t);
          if (this.#u) this.#a?.push([n, e, t]);
        }
        if (this.#o.delete(e), this.#r[o] = void 0, this.#e[o] = void 0, o === this.#s) this.#s = this.#p[o];
        else if (o === this.#c) this.#c = this.#l[o];
        else {
          let i = this.#p[o];
          this.#l[i] = this.#l[o];
          let s = this.#l[o];
          this.#p[s] = this.#p[o];
        }
        this.#i--, this.#b.push(o);
      }
    }
    if (this.#u && this.#a?.length) {
      let o = this.#a, n;
      while (n = o?.shift()) this.#h?.(...n);
    }
    return r;
  }
  clear() {
    return this.#L("delete");
  }
  #L(e) {
    for (let t of this.#w({ allowStale: true })) {
      let r = this.#e[t];
      if (this.#t(r)) r.__abortController.abort(Error("deleted"));
      else {
        let o = this.#r[t];
        if (this.#S) this.#g?.(r, o, e);
        if (this.#u) this.#a?.push([r, o, e]);
      }
    }
    if (this.#o.clear(), this.#e.fill(void 0), this.#r.fill(void 0), this.#f && this.#v) this.#f.fill(0), this.#v.fill(0);
    if (this.#_) this.#_.fill(0);
    if (this.#c = 0, this.#s = 0, this.#b.length = 0, this.#y = 0, this.#i = 0, this.#u && this.#a) {
      let t = this.#a, r;
      while (r = t?.shift()) this.#h?.(...r);
    }
  }
};
function lj(e, t, r = 100) {
  let o = new ug({ max: r }), n = (...i) => {
    let s = t(...i), a = o.get(s);
    if (a !== void 0) return a;
    let c = e(...i);
    return o.set(s, c), c;
  };
  return n.cache = { clear: () => o.clear(), size: () => o.size, delete: (i) => o.delete(i), get: (i) => o.peek(i), has: (i) => o.has(i) }, n;
}
var Hee = 8192;
function dj(e, t) {
  try {
    return { ok: true, value: JSON.parse(ag(e)) };
  } catch (r) {
    if (t) cg(dE(r, `safeParseJSON: invalid JSON (${r instanceof Error ? r.constructor.name : typeof r}, ${e.length} bytes)`));
    return { ok: false };
  }
}
var uj = lj(dj, (e) => e, 50);
var Ds = Object.assign(function(t, r = true) {
  if (!t) return null;
  let o = t.length > Hee ? dj(t, r) : uj(t, r);
  return o.ok ? o.value : null;
}, { cache: uj.cache });
var Vo = Ce(() => {
  try {
    if (process.platform === "darwin") return "macos";
    if (process.platform === "win32") return "windows";
    if (process.platform === "linux") {
      if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return "wsl";
      try {
        let e = He().readFileSync("/proc/version", { encoding: "utf8" });
        if (e.toLowerCase().includes("microsoft") || e.toLowerCase().includes("wsl")) return "wsl";
      } catch (e) {
        ee(`Failed to read /proc/version for WSL detection: ${e}`, { level: "error" });
      }
      return "linux";
    }
    return "unknown";
  } catch (e) {
    return cg(e), "unknown";
  }
});
var mRe = Ce(() => {
  if (process.platform !== "linux") return;
  try {
    let e = He().readFileSync("/proc/version", { encoding: "utf8" }), t = e.match(/WSL(\d+)/i);
    if (t && t[1]) return t[1];
    if (e.toLowerCase().includes("microsoft")) return "1";
    return;
  } catch (e) {
    ee(`Failed to read /proc/version for WSL detection: ${e}`, { level: "error" });
    return;
  }
});
var gRe = Ce(async () => {
  if (process.platform !== "linux") return;
  let e = { linuxKernel: pj() };
  try {
    let t = await Bee("/etc/os-release", "utf8");
    for (let r of t.split(`
`)) {
      let o = r.match(/^(ID|VERSION_ID)=(.*)$/);
      if (o && o[1] && o[2]) {
        let n = o[2].replace(/^"|"$/g, "");
        if (o[1] === "ID") e.linuxDistroId = n;
        else e.linuxDistroVersion = n;
      }
    }
  } catch {
  }
  return e;
});
var hRe = Ce(() => {
  if (process.platform !== "darwin") return;
  let t = pj().match(/^(\d+)\./);
  if (!t || !t[1]) return;
  return parseInt(t[1], 10) - 9;
});
var Zo = Ce(function() {
  switch (Vo()) {
    case "macos":
      return "/Library/Application Support/ClaudeCode";
    case "windows":
      return "C:\\Program Files\\ClaudeCode";
    default:
      return "/etc/claude-code";
  }
});
var SRe = Ce(function() {
  return qee(Zo(), "managed-settings.d");
});
function Vee(e, t, r) {
  if (r !== void 0 && !fn(e[t], r) || r === void 0 && !(t in e)) Pi(e, t, r);
}
var cu = Vee;
function Zee(e) {
  return function(t, r, o) {
    var n = -1, i = Object(t), s = o(t), a = s.length;
    while (a--) {
      var c = s[e ? a : ++n];
      if (r(i[c], c, i) === false) break;
    }
    return t;
  };
}
var fj = Zee;
var Wee = fj();
var mj = Wee;
function Kee(e) {
  return Gt(e) && Ii(e);
}
var gj = Kee;
var Gee = "[object Object]";
var Jee = Function.prototype;
var Xee = Object.prototype;
var hj = Jee.toString;
var Yee = Xee.hasOwnProperty;
var Qee = hj.call(Object);
function ete(e) {
  if (!Gt(e) || Er(e) != Gee) return false;
  var t = bd(e);
  if (t === null) return true;
  var r = Yee.call(t, "constructor") && t.constructor;
  return typeof r == "function" && r instanceof r && hj.call(r) == Qee;
}
var yj = ete;
function tte(e, t) {
  if (t === "constructor" && typeof e[t] === "function") return;
  if (t == "__proto__") return;
  return e[t];
}
var lu = tte;
function rte(e) {
  return IE(e, gd(e));
}
var bj = rte;
function nte(e, t, r, o, n, i, s) {
  var a = lu(e, r), c = lu(t, r), u = s.get(c);
  if (u) {
    cu(e, r, u);
    return;
  }
  var d = i ? i(a, c, r + "", e, t, s) : void 0, p = d === void 0;
  if (p) {
    var f = pt(c), m = !f && Ka(c), g = !f && !m && fd(c);
    if (d = c, f || m || g) if (pt(a)) d = a;
    else if (gj(a)) d = WE(a);
    else if (m) p = false, d = Eh(c, true);
    else if (g) p = false, d = JE(c, true);
    else d = [];
    else if (yj(c) || Hr(c)) {
      if (d = a, Hr(a)) d = bj(a);
      else if (!Qe(a) || ti(a)) d = QE(c);
    } else p = false;
  }
  if (p) s.set(c, d), n(d, c, o, i, s), s.delete(c);
  cu(e, r, d);
}
var _j = nte;
function vj(e, t, r, o, n) {
  if (e === t) return;
  mj(t, function(i, s) {
    if (n || (n = new TE()), Qe(i)) _j(e, t, s, r, vj, o, n);
    else {
      var a = o ? o(lu(e, s), i, s + "", e, t, n) : void 0;
      if (a === void 0) a = i;
      cu(e, s, a);
    }
  }, gd);
}
var Sj = vj;
function ote(e, t, r) {
  switch (r.length) {
    case 0:
      return e.call(t);
    case 1:
      return e.call(t, r[0]);
    case 2:
      return e.call(t, r[0], r[1]);
    case 3:
      return e.call(t, r[0], r[1], r[2]);
  }
  return e.apply(t, r);
}
var xj = ote;
var wj = Math.max;
function ite(e, t, r) {
  return t = wj(t === void 0 ? e.length - 1 : t, 0), function() {
    var o = arguments, n = -1, i = wj(o.length - t, 0), s = Array(i);
    while (++n < i) s[n] = o[t + n];
    n = -1;
    var a = Array(t + 1);
    while (++n < t) a[n] = o[n];
    return a[t] = r(s), xj(e, this, a);
  };
}
var dg = ite;
function ste(e) {
  return function() {
    return e;
  };
}
var kj = ste;
var ate = !Ei ? _d : function(e, t) {
  return Ei(e, "toString", { configurable: true, enumerable: false, value: kj(t), writable: true });
};
var Ej = ate;
var cte = 800;
var lte = 16;
var ute = Date.now;
function dte(e) {
  var t = 0, r = 0;
  return function() {
    var o = ute(), n = lte - (o - r);
    if (r = o, n > 0) {
      if (++t >= cte) return arguments[0];
    } else t = 0;
    return e.apply(void 0, arguments);
  };
}
var Pj = dte;
var pte = Pj(Ej);
var pg = pte;
function fte(e, t) {
  return pg(dg(e, t, _d), e + "");
}
var Tj = fte;
function mte(e, t, r) {
  if (!Qe(r)) return false;
  var o = typeof t;
  if (o == "number" ? Ii(r) && xn(t, r.length) : o == "string" && t in r) return fn(r[t], e);
  return false;
}
var Ij = mte;
function gte(e) {
  return Tj(function(t, r) {
    var o = -1, n = r.length, i = n > 1 ? r[n - 1] : void 0, s = n > 2 ? r[2] : void 0;
    if (i = e.length > 3 && typeof i == "function" ? (n--, i) : void 0, s && Ij(r[0], r[1], s)) i = n < 3 ? void 0 : i, n = 1;
    t = Object(t);
    while (++o < n) {
      var a = r[o];
      if (a) e(t, a, o, i);
    }
    return t;
  });
}
var Rj = gte;
var hte = Rj(function(e, t, r, o) {
  Sj(e, t, r, o);
});
function yte(e, t, r, o) {
  if (!Qe(e)) return e;
  t = wn(t, e);
  var n = -1, i = t.length, s = i - 1, a = e;
  while (a != null && ++n < i) {
    var c = $i(t[n]), u = r;
    if (c === "__proto__" || c === "constructor" || c === "prototype") return e;
    if (n != s) {
      var d = a[c];
      if (u = o ? o(d, c, a) : void 0, u === void 0) u = Qe(d) ? d : xn(t[n + 1]) ? [] : {};
    }
    ad(a, c, u), a = a[c];
  }
  return e;
}
var $j = yte;
function bte(e, t, r) {
  var o = -1, n = t.length, i = {};
  while (++o < n) {
    var s = t[o], a = lP(e, s);
    if (r(a, s)) $j(i, wn(s, e), a);
  }
  return i;
}
var Aj = bte;
function _te(e, t) {
  return Aj(e, t, function(r, o) {
    return pP(e, o);
  });
}
var Oj = _te;
var Cj = qt ? qt.isConcatSpreadable : void 0;
function vte(e) {
  return pt(e) || Hr(e) || !!(Cj && e && e[Cj]);
}
var Mj = vte;
function Dj(e, t, r, o, n) {
  var i = -1, s = e.length;
  r || (r = Mj), n || (n = []);
  while (++i < s) {
    var a = e[i];
    if (t > 0 && r(a)) if (t > 1) Dj(a, t - 1, r, o, n);
    else KE(n, a);
    else if (!o) n[n.length] = a;
  }
  return n;
}
var Nj = Dj;
function Ste(e) {
  var t = e == null ? 0 : e.length;
  return t ? Nj(e, 1) : [];
}
var jj = Ste;
function xte(e) {
  return pg(dg(e, void 0, jj), e + "");
}
var Uj = xte;
var wte = Uj(function(e, t) {
  return e == null ? {} : Oj(e, t);
});
var $te = T(() => l.object({ allowedDomains: l.array(l.string()).optional(), deniedDomains: l.array(l.string()).optional().describe("Domains that are always blocked, even if matched by allowedDomains. Supports the same wildcard syntax as allowedDomains. Merged from all settings sources regardless of allowManagedDomainsOnly."), allowManagedDomainsOnly: l.boolean().optional().describe("When true (and set in managed settings), only allowedDomains and WebFetch(domain:...) allow rules from managed settings are respected. User, project, local, and flag settings domains are ignored. Denied domains are still respected from all sources."), allowUnixSockets: l.array(l.string()).optional().describe("macOS only: Unix socket paths to allow. Ignored on Linux (seccomp cannot filter by path)."), allowAllUnixSockets: l.boolean().optional().describe("If true, allow all Unix sockets (disables blocking on both platforms)."), allowLocalBinding: l.boolean().optional(), allowMachLookup: l.array(l.string().refine((e) => !(e.endsWith("*") ? e.slice(0, -1) : e).includes("*"), { message: 'Wildcards are only allowed as a single trailing "*" (e.g., "com.example.*" or "*" for all services).' })).optional().describe('macOS only: Additional XPC/Mach service names to allow looking up. Supports trailing-wildcard prefix matching (e.g., "com.apple.coresimulator.*"). Needed for tools that communicate via XPC such as the iOS Simulator or Playwright.'), httpProxyPort: l.number().optional(), socksProxyPort: l.number().optional(), tlsTerminate: l.object({ caCertPath: l.string().min(1).optional(), caKeyPath: l.string().min(1).optional() }).optional().describe("[EXPERIMENTAL] Enable in-process TLS termination so the per-request filter can see HTTPS request bodies. Provide a CA cert+key, or omit both to have sandbox-runtime generate an ephemeral one for the session.") }).optional());
var Ate = T(() => l.object({ allowWrite: l.array(l.string()).optional().describe("Additional paths to allow writing within the sandbox. Merged with paths from Edit(...) allow permission rules."), denyWrite: l.array(l.string()).optional().describe("Additional paths to deny writing within the sandbox. Merged with paths from Edit(...) deny permission rules."), denyRead: l.array(l.string()).optional().describe("Additional paths to deny reading within the sandbox. Merged with paths from Read(...) deny permission rules."), allowRead: l.array(l.string()).optional().describe("Paths to re-allow reading within denyRead regions. Takes precedence over denyRead for matching paths."), allowManagedReadPathsOnly: l.boolean().optional().describe("When true (set in managed settings), only allowRead paths from policySettings are used.") }).optional());
var Hx = T(() => l.object({ path: l.string().min(1).describe("Path to a credential file or directory. Same resolution as sandbox.filesystem.* paths: absolute, ~ expanded, or relative to the settings file root (project root for project settings, ~/.claude for user settings)."), mode: l.literal("deny").describe("Access mode for this path. Only `deny` is supported.") }));
var Bx = T(() => l.object({ name: l.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Environment variable name must start with a letter or underscore and contain only letters, digits, and underscores").describe("Environment variable name."), mode: l.literal("deny").describe("Access mode for this environment variable. Only `deny` is supported.") }));
var Ote = T(() => l.object({ files: l.array(Hx()).optional().describe("Credential files or directories to protect. `deny` blocks reads inside the sandbox."), envVars: l.array(Bx()).optional().describe("Environment variables to protect. `deny` unsets the variable for sandboxed commands.") }).optional());
var qx = T(() => l.object({ enabled: l.boolean().optional(), failIfUnavailable: l.boolean().optional().describe("Exit with an error at startup if sandbox.enabled is true but the sandbox cannot start (missing dependencies or unsupported platform). When false (default), a warning is shown and commands run unsandboxed. Intended for managed-settings deployments that require sandboxing as a hard gate."), autoAllowBashIfSandboxed: l.boolean().optional(), allowUnsandboxedCommands: l.boolean().optional().describe("Allow commands to run outside the sandbox via the dangerouslyDisableSandbox parameter. When false, the dangerouslyDisableSandbox parameter is completely ignored and all commands must run sandboxed. Default: true."), network: $te(), filesystem: Ate(), credentials: Ote(), ignoreViolations: l.record(l.string(), l.array(l.string())).optional(), enableWeakerNestedSandbox: l.boolean().optional(), enableWeakerNetworkIsolation: l.boolean().optional().describe("macOS only: Allow access to com.apple.trustd.agent in the sandbox. Needed for Go-based CLI tools (gh, gcloud, terraform, etc.) to verify TLS certificates when using httpProxyPort with a MITM proxy and custom CA. **Reduces security** \u2014 opens a potential data exfiltration vector through the trustd service. Default: false"), allowAppleEvents: l.boolean().optional().describe("macOS only: Allow sandboxed commands to send Apple Events (and look up the appleeventsd Mach service). Needed for `open`, `osascript`, and browser-based auth flows that open URLs. **Removes code-execution isolation** \u2014 sandboxed commands can launch other applications unsandboxed with no user prompt, and can script running apps (e.g. Terminal) subject to the user's per-app TCC automation consent. Only honored from user, managed/policy, or CLI (--settings) settings \u2014 project settings (.claude/settings.json and .claude/settings.local.json) are ignored. Default: false"), excludedCommands: l.array(l.string()).optional(), ripgrep: l.object({ command: l.string(), args: l.array(l.string()).optional() }).optional().describe("Custom ripgrep configuration for bundled ripgrep support"), bwrapPath: l.preprocess((e) => typeof e === "string" && Wj(e) ? e : void 0, l.string()).optional().catch(void 0).describe("Linux/WSL only: Absolute path to the bwrap (bubblewrap) binary. Overrides auto-detection via PATH. Only honored from admin-controlled managed settings."), socatPath: l.preprocess((e) => typeof e === "string" && Wj(e) ? e : void 0, l.string()).optional().catch(void 0).describe("Linux/WSL only: Absolute path to the socat binary used for the sandbox network proxy. Overrides auto-detection via PATH. Only honored from admin-controlled managed settings.") }).passthrough());
var Kj = ["auto", "iterm2", "iterm2_with_bell", "terminal_bell", "kitty", "ghostty", "notifications_disabled"];
var Gj = ["normal", "vim"];
var Jj = ["auto", "tmux", "iterm2", "in-process"];
var Cte = ["dark", "light", "light-daltonized", "dark-daltonized", "light-ansi", "dark-ansi"];
var Xj = ["auto", ...Cte];
var AAe = Vo() === "macos" ? "\u23FA" : "\u25CF";
var pu = ["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"];
var Mte = [...pu, "bubble"];
var Yj = Mte;
var zAe = T(() => Xv.enum(Yj));
var LAe = T(() => Xv.enum(pu));
var Qj = ["bash", "powershell"];
var fu = T(() => l.string().optional().describe('Permission rule syntax to filter when this hook runs (e.g., "Bash(git *)"). Only runs if the tool call matches the pattern. Avoids spawning hooks for non-matching commands.'));
function Dte() {
  let e = l.object({ type: l.literal("command").describe("Shell command hook type"), command: l.string().describe("Shell command to execute"), args: l.array(l.string()).optional().describe("Argument list for exec form. When present, `command` is resolved as an executable and spawned directly with these arguments \u2014 no shell. Path placeholders like ${CLAUDE_PLUGIN_ROOT} are substituted per-element as plain strings, so paths with quotes, $, or backticks never reach a shell parser. When absent, `command` runs through a shell (bash on POSIX, PowerShell on Windows without Git Bash)."), if: fu(), shell: l.enum(Qj).optional().describe("Shell interpreter. 'bash' uses your $SHELL (bash/zsh/sh); 'powershell' uses pwsh. Defaults to bash (powershell on Windows without Git Bash)."), timeout: l.number().positive().optional().describe("Timeout in seconds for this specific command"), statusMessage: l.string().optional().describe("Custom status message to display in spinner while hook runs"), once: l.boolean().optional().describe("If true, hook runs once and is removed after execution"), async: l.boolean().optional().describe("If true, hook runs in background without blocking"), asyncRewake: l.boolean().optional().describe("If true, hook runs in background and wakes the model on exit code 2 (blocking error). Implies async."), rewakeMessage: l.string().min(1).optional().describe("@internal Custom prefix for the system-reminder shown to the model when an asyncRewake hook exits with code 2. The hook output is appended after this prefix."), rewakeSummary: l.string().min(1).optional().describe('@internal One-line summary shown to the user in the terminal when an asyncRewake hook exits with code 2. Defaults to "Stop hook feedback".') }), t = l.object({ type: l.literal("prompt").describe("LLM prompt hook type"), prompt: l.string().describe("Prompt to evaluate with LLM. Use $ARGUMENTS placeholder for hook input JSON."), if: fu(), timeout: l.number().positive().optional().describe("Timeout in seconds for this specific prompt evaluation"), model: l.string().optional().describe('Model to use for this prompt hook (e.g., "claude-sonnet-5"). If not specified, uses the default small fast model.'), continueOnBlock: l.boolean().optional().describe(`Sets the continue value for the decision:"block" produced when ok is false. Default false (turn ends). Whether continue:true lets the turn proceed depends on the event's decision:"block" semantics. On PostToolUse, the reason is fed back to Claude and the turn continues.`), statusMessage: l.string().optional().describe("Custom status message to display in spinner while hook runs"), once: l.boolean().optional().describe("If true, hook runs once and is removed after execution") }), r = l.object({ type: l.literal("mcp_tool").describe("MCP tool hook type"), server: l.string().describe("Name of an already-configured MCP server to invoke"), tool: l.string().describe("Name of the tool on that server to call"), input: l.record(l.string(), l.unknown()).optional().describe('Arguments passed to the MCP tool. String values support ${path} interpolation from the hook input JSON (e.g. "${tool_input.file_path}").'), if: fu(), timeout: l.number().positive().optional().describe("Timeout in seconds for this specific tool call"), statusMessage: l.string().optional().describe("Custom status message to display in spinner while hook runs"), once: l.boolean().optional().describe("If true, hook runs once and is removed after execution") }), o = l.object({ type: l.literal("http").describe("HTTP hook type"), url: l.string().url().describe("URL to POST the hook input JSON to"), if: fu(), timeout: l.number().positive().optional().describe("Timeout in seconds for this specific request"), headers: l.record(l.string(), l.string()).optional().describe('Additional headers to include in the request. Values may reference environment variables using $VAR_NAME or ${VAR_NAME} syntax (e.g., "Authorization": "Bearer $MY_TOKEN"). Only variables listed in allowedEnvVars will be interpolated.'), allowedEnvVars: l.array(l.string()).optional().describe("Explicit list of environment variable names that may be interpolated in header values. Only variables listed here will be resolved; all other $VAR references are left as empty strings. Required for env var interpolation to work."), statusMessage: l.string().optional().describe("Custom status message to display in spinner while hook runs"), once: l.boolean().optional().describe("If true, hook runs once and is removed after execution") }), n = l.object({ type: l.literal("agent").describe("Agentic verifier hook type"), prompt: l.string().describe('Prompt describing what to verify (e.g. "Verify that unit tests ran and passed."). Use $ARGUMENTS placeholder for hook input JSON.'), if: fu(), timeout: l.number().positive().optional().describe("Timeout in seconds for agent execution (default 60)"), model: l.string().optional().describe('Model to use for this agent hook (e.g., "claude-sonnet-5"). If not specified, uses Haiku.'), statusMessage: l.string().optional().describe("Custom status message to display in spinner while hook runs"), once: l.boolean().optional().describe("If true, hook runs once and is removed after execution") });
  return { BashCommandHookSchema: e, PromptHookSchema: t, HttpHookSchema: o, AgentHookSchema: n, McpToolHookSchema: r };
}
var eU = T(() => {
  let { BashCommandHookSchema: e, PromptHookSchema: t, AgentHookSchema: r, HttpHookSchema: o, McpToolHookSchema: n } = Dte();
  return l.discriminatedUnion("type", [e, t, r, o, n]);
});
var tU = T(() => l.object({ matcher: l.string().optional().describe('String pattern to match (e.g. tool names like "Write")'), hooks: l.array(eU()).describe("List of hooks to execute when the matcher matches") }));
var Wo = T(() => l.partialRecord(l.enum(ei), l.array(tU())));
var JAe = T(() => l.enum(["local", "user", "project", "dynamic", "enterprise", "claudeai", "managed", "agent"]));
var XAe = T(() => l.enum(["stdio", "sse", "sse-ide", "http", "ws", "sdk"]));
var js = T(() => l.literal("comms").optional().catch(void 0));
var Xn = T(() => l.number().int().positive());
var Nte = T(() => l.object({ type: l.literal("stdio").optional(), command: l.string().min(1, "Command cannot be empty"), args: l.array(l.string()).default([]), env: l.record(l.string(), l.string()).optional(), timeout: Xn().optional(), alwaysLoad: l.boolean().optional(), role: js() }));
var jte = T(() => l.boolean());
var rU = T(() => l.object({ clientId: l.string().optional(), callbackPort: l.number().int().positive().optional(), authServerMetadataUrl: l.string().url().startsWith("https://", { message: "authServerMetadataUrl must use https://" }).optional(), scopes: l.string().min(1).optional(), xaa: jte().optional() }));
var nU = T(() => l.object({ name: l.string(), permission_policy: l.enum(["always_allow", "always_ask", "always_deny"]).optional() }));
var Ute = T(() => l.object({ type: l.literal("sse"), url: l.string(), headers: l.record(l.string(), l.string()).optional(), headersHelper: l.string().optional(), oauth: rU().optional(), timeout: Xn().optional(), tools: l.array(nU()).optional(), alwaysLoad: l.boolean().optional(), role: js(), toolPermissions: l.record(l.string(), Vx()).optional() }));
var zte = T(() => l.object({ type: l.literal("sse-ide"), url: l.string(), ideName: l.string(), ideRunningInWindows: l.boolean().optional(), timeout: Xn().optional(), alwaysLoad: l.boolean().optional(), role: js() }));
var Lte = T(() => l.object({ type: l.literal("ws-ide"), url: l.string(), ideName: l.string(), authToken: l.string().optional(), ideRunningInWindows: l.boolean().optional(), timeout: Xn().optional(), alwaysLoad: l.boolean().optional(), role: js() }));
var Fte = T(() => l.object({ type: l.enum(["http", "streamable-http"]).transform(() => "http"), url: l.string(), headers: l.record(l.string(), l.string()).optional(), headersHelper: l.string().optional(), oauth: rU().optional(), timeout: Xn().optional(), tools: l.array(nU()).optional(), alwaysLoad: l.boolean().optional(), role: js(), toolPermissions: l.record(l.string(), Vx()).optional() }));
var Hte = T(() => l.object({ type: l.literal("ws"), url: l.string(), headers: l.record(l.string(), l.string()).optional(), headersHelper: l.string().optional(), timeout: Xn().optional(), alwaysLoad: l.boolean().optional(), role: js() }));
var Bte = T(() => l.object({ type: l.literal("sdk"), name: l.string(), timeout: Xn().optional(), alwaysLoad: l.boolean().optional() }));
var Vx = T(() => l.enum(["allow", "ask", "blocked"]));
var qte = T(() => l.object({ type: l.literal("claudeai-proxy"), url: l.string(), id: l.string(), displayName: l.string().optional(), iconUrl: l.string().optional(), timeout: Xn().optional(), alwaysLoad: l.boolean().optional(), toolPermissions: l.record(l.string(), Vx()).optional(), stateless: l.boolean().optional(), cachedInitResponse: l.record(l.string(), l.unknown()).nullish() }));
var gg = T(() => l.union([Nte(), Ute(), zte(), Lte(), Fte(), Hte(), Bte(), qte()]));
var YAe = T(() => l.object({ mcpServers: l.record(l.string(), gg()) }));
var Vte = /* @__PURE__ */ new Set(["claude-community", "claude-plugins-community"]);
var Zte = /* @__PURE__ */ new Set(["claude-code-marketplace", "claude-code-plugins", "claude-plugins-official", "anthropic-marketplace", "anthropic-plugins", "agent-skills", "anthropic-agent-skills", "life-sciences", "knowledge-work-plugins", "claude-for-legal", "claude-for-financial-services", "financial-services-plugins"]);
var aU = /* @__PURE__ */ new Set([...Zte, ...Vte]);
var Wte = /(?:official[^a-z0-9]*(anthropic|claude)|(?:anthropic|claude)[^a-z0-9]*official|^(?:anthropic|claude)[^a-z0-9]*(marketplace|plugins|official))/i;
var Kte = /[^\u0020-\u007E]/;
function Gte(e) {
  if (aU.has(e.toLowerCase())) return false;
  if (Kte.test(e)) return true;
  return Wte.test(e);
}
var xr = T(() => l.string().startsWith("./"));
var Ko = T(() => xr().endsWith(".json"));
var oU = T(() => l.union([xr().refine((e) => e.endsWith(".mcpb") || e.endsWith(".dxt"), { message: "MCPB file path must end with .mcpb or .dxt" }).describe("Path to MCPB file relative to plugin root"), l.string().url().refine((e) => e.endsWith(".mcpb") || e.endsWith(".dxt"), { message: "MCPB URL must end with .mcpb or .dxt" }).describe("URL to MCPB file")]));
var Wx = T(() => xr().endsWith(".md"));
var Kx = T(() => l.union([Wx(), xr()]));
var cU = T(() => l.string().min(1, "Marketplace must have a name").refine((e) => !e.includes(" "), { message: 'Marketplace name cannot contain spaces. Use kebab-case (e.g., "my-marketplace")' }).refine((e) => !e.includes("/") && !e.includes("\\") && !e.includes("..") && e !== ".", { message: 'Marketplace name cannot contain path separators (/ or \\), ".." sequences, or be "."' }).refine((e) => !Gte(e), { message: "Marketplace name impersonates an official Anthropic/Claude marketplace" }).refine((e) => e.toLowerCase() !== "inline", { message: 'Marketplace name "inline" is reserved for --plugin-dir session plugins' }).refine((e) => e.toLowerCase() !== "builtin", { message: 'Marketplace name "builtin" is reserved for built-in plugins' }).refine((e) => e.toLowerCase() !== "skills-dir", { message: 'Marketplace name "skills-dir" is reserved for plugins auto-loaded from .claude/skills/' }));
var Gx = T(() => l.object({ name: l.string().min(1, "Author name cannot be empty").describe("Display name of the plugin author or organization"), email: l.string().optional().describe("Contact email for support or feedback"), url: l.string().optional().describe("Website, GitHub profile, or organization URL") }));
var Jte = T(() => l.object({ $schema: l.string().optional().describe("JSON Schema reference for editor autocomplete/validation; ignored at load time"), name: l.string().min(1, "Plugin name cannot be empty").refine((e) => !e.includes(" "), { message: 'Plugin name cannot contain spaces. Use kebab-case (e.g., "my-plugin")' }).describe("Unique identifier for the plugin, used for namespacing (prefer kebab-case)"), displayName: l.string().optional().describe('Human-readable name shown in UI (e.g., "GitHub Utils"). Falls back to `name` when omitted. Unlike `name`, may contain spaces and any casing; not used for namespacing or lookup.'), version: l.string().optional().describe("Semantic version (e.g., 1.2.3) following semver.org specification"), description: l.string().optional().describe("Brief, user-facing explanation of what the plugin provides"), author: Gx().optional().describe("Information about the plugin creator or maintainer"), homepage: l.string().url().optional().describe("Plugin homepage or documentation URL"), repository: l.string().optional().describe("Source code repository URL"), license: l.string().optional().describe("SPDX license identifier (e.g., MIT, Apache-2.0)"), keywords: l.array(l.string()).optional().describe("Tags for plugin discovery and categorization"), defaultEnabled: l.boolean().optional().describe("Whether the plugin starts enabled when the user has no explicit enabled/disabled setting for it (default: true). Explicit enabledPlugins values always win, and a plugin required by an enabled dependent is enabled regardless of this value."), dependencies: l.array(Ere()).optional().describe(`Plugins that must be enabled for this plugin to function. Bare names (no "@marketplace") are resolved against the declaring plugin's own marketplace.`) }));
var uOe = T(() => l.object({ description: l.string().optional().describe("Brief, user-facing explanation of what these hooks provide"), hooks: l.lazy(() => Wo()).describe("The hooks provided by the plugin, in the same format as the one used for settings") }));
var Xte = T(() => l.object({ hooks: l.union([Ko().describe("Path to file with additional hooks (in addition to those in hooks/hooks.json, if it exists), relative to the plugin root"), l.lazy(() => Wo()).describe("Additional hooks (in addition to those in hooks/hooks.json, if it exists)"), l.array(l.union([Ko().describe("Path to file with additional hooks (in addition to those in hooks/hooks.json, if it exists), relative to the plugin root"), l.lazy(() => Wo()).describe("Additional hooks (in addition to those in hooks/hooks.json, if it exists)")]))]) }));
var Yte = T(() => l.object({ source: Kx().optional().describe("Path to command markdown file, relative to plugin root"), content: l.string().optional().describe("Inline markdown content for the command"), description: l.string().optional().describe("Command description override"), argumentHint: l.string().optional().describe('Hint for command arguments (e.g., "[file]")'), model: l.string().optional().describe("Default model for this command"), allowedTools: l.array(l.string()).optional().describe("Tools allowed when command runs") }).refine((e) => e.source && !e.content || !e.source && e.content, { message: 'Command must have either "source" (file path) or "content" (inline markdown), but not both' }));
var Qte = T(() => l.object({ commands: l.union([Kx().describe("Path to a command file or skill directory, relative to the plugin root. When set, the commands/ directory is not auto-loaded \u2014 list its files here if you want both."), l.array(Kx().describe("Path to a command file or skill directory, relative to the plugin root. When set, the commands/ directory is not auto-loaded \u2014 list its files here if you want both.")).describe("List of command file or skill directory paths. When set, the commands/ directory is not auto-loaded."), l.record(l.string(), Yte()).describe('Object mapping of command names to their metadata and source files. Command name becomes the slash command name (e.g., "about" \u2192 "/plugin:about")')]) }));
var ere = T(() => l.object({ agents: l.union([Wx().describe("Path to an agent file, relative to the plugin root. When set, the agents/ directory is not auto-loaded \u2014 list its files here if you want both."), l.array(Wx().describe("Path to an agent file, relative to the plugin root. When set, the agents/ directory is not auto-loaded \u2014 list its files here if you want both.")).describe("List of agent file paths. When set, the agents/ directory is not auto-loaded.")]) }));
var tre = T(() => l.object({ skills: l.union([xr().describe("Path to a skill directory, relative to the plugin root. Loaded in addition to the skills/ directory (except: for a marketplace entry whose source resolves to the marketplace root, declaring a specific subdirectory replaces the skills/ scan)."), l.array(xr().describe("Path to a skill directory, relative to the plugin root.")).describe("List of skill directory paths, loaded in addition to the skills/ directory (except: for a marketplace entry whose source resolves to the marketplace root, declaring specific subdirectories replaces the skills/ scan).")]) }));
var lU = T(() => l.object({ outputStyles: l.union([xr().describe("Path to an output-styles directory or file, relative to the plugin root. When set, the output-styles/ directory is not auto-loaded \u2014 list its files here if you want both."), l.array(xr().describe("Path to an output-styles directory or file, relative to the plugin root. When set, the output-styles/ directory is not auto-loaded \u2014 list its files here if you want both.")).describe("List of output-style directory or file paths. When set, the output-styles/ directory is not auto-loaded.")]) }));
var uU = T(() => l.object({ themes: l.union([xr().describe("Path to a themes directory or file, relative to the plugin root. When set, the themes/ directory is not auto-loaded \u2014 list its files here if you want both."), l.array(xr().describe("Path to a themes directory or file, relative to the plugin root. When set, the themes/ directory is not auto-loaded \u2014 list its files here if you want both.")).describe("List of theme directory or file paths. When set, the themes/ directory is not auto-loaded.")]) }));
var rre = T(() => l.object({}));
var iU = T(() => l.string().min(1));
var nre = T(() => l.string().min(2).refine((e) => e.startsWith("."), { message: 'File extensions must start with dot (e.g., ".ts", not "ts")' }));
var ore = T(() => l.object({ mcpServers: l.union([Ko().describe("MCP servers to include in the plugin (in addition to those in the .mcp.json file, if it exists)"), oU().describe("Path or URL to MCPB file containing MCP server configuration"), l.record(l.string(), gg()).describe("MCP server configurations keyed by server name"), l.array(l.union([Ko().describe("Path to MCP servers configuration file"), oU().describe("Path or URL to MCPB file"), l.record(l.string(), gg()).describe("Inline MCP server configurations")])).describe("Array of MCP server configurations (paths, MCPB files, or inline definitions)")]) }));
var dU = T(() => l.object({ type: l.enum(["string", "number", "boolean", "directory", "file"]).describe("Type of the configuration value"), title: l.string().describe("Human-readable label shown in the config dialog"), description: l.string().describe("Help text shown beneath the field in the config dialog"), required: l.boolean().optional().describe("If true, validation fails when this field is empty"), default: l.union([l.string(), l.number(), l.boolean(), l.array(l.string())]).optional().describe("Default value used when the user provides nothing"), multiple: l.boolean().optional().describe("For string type: allow an array of strings"), sensitive: l.boolean().optional().describe("If true, masks dialog input and stores value in secure storage (keychain/credentials file) instead of settings.json"), min: l.number().optional().describe("Minimum value (number type only)"), max: l.number().optional().describe("Maximum value (number type only)") }).strict());
var ire = T(() => l.object({ userConfig: l.record(l.string().regex(/^[A-Za-z_]\w*$/, "Option keys must be valid identifiers (letters, digits, underscore; no leading digit) \u2014 they become CLAUDE_PLUGIN_OPTION_<KEY> env vars in hooks"), dU()).optional().describe("User-configurable values this plugin needs. Prompted at enable time. Non-sensitive values saved to settings.json; sensitive values to secure storage. Available as ${user_config.KEY} in MCP/LSP server config, hook commands, and (non-sensitive only) skill/agent content. Keep sensitive value counts small.") }));
var sre = T(() => l.object({ channels: l.array(l.object({ server: l.string().min(1).describe("Name of the MCP server this channel binds to. Must match a key in this plugin's mcpServers."), displayName: l.string().optional().describe('Human-readable name shown in the config dialog title (e.g., "Telegram"). Defaults to the server name.'), userConfig: l.record(l.string(), dU()).optional().describe("Fields to prompt the user for when enabling this plugin in assistant mode. Saved values are substituted into ${user_config.KEY} references in the mcpServers env.") }).strict()).describe("Channels this plugin provides. Each entry declares an MCP server as a message channel and optionally specifies user configuration to prompt for at enable time.") }));
var sU = T(() => l.strictObject({ command: l.string().min(1).refine((e) => {
  if (e.includes(" ") && !e.startsWith("/")) return false;
  return true;
}, { message: "Command should not contain spaces. Use args array for arguments." }).describe('Command to execute the LSP server (e.g., "typescript-language-server")'), args: l.array(iU()).optional().describe("Command-line arguments to pass to the server"), extensionToLanguage: l.record(nre(), iU()).refine((e) => Object.keys(e).length > 0, { message: "extensionToLanguage must have at least one mapping" }).describe("Mapping from file extension to LSP language ID. File extensions and languages are derived from this mapping."), transport: l.enum(["stdio", "socket"]).default("stdio").describe("Communication transport mechanism"), env: l.record(l.string(), l.string()).optional().describe("Environment variables to set when starting the server"), initializationOptions: l.unknown().optional().describe("Initialization options passed to the server during initialization"), settings: l.unknown().optional().describe("Settings passed to the server via workspace/didChangeConfiguration"), workspaceFolder: l.string().optional().describe("Workspace folder path to use for the server"), startupTimeout: l.number().int().positive().optional().describe("Maximum time to wait for server startup (milliseconds)"), shutdownTimeout: l.number().int().positive().optional().describe("Maximum time to wait for graceful shutdown (milliseconds)"), restartOnCrash: l.boolean().optional().describe("Whether to restart the server if it crashes"), maxRestarts: l.number().int().nonnegative().optional().describe("Maximum number of restart attempts before giving up"), diagnostics: l.boolean().optional().describe("Whether to push publishDiagnostics into the agent context after edits. Set to false to keep LSP navigation (goToDefinition, hover, etc.) but suppress automatic diagnostic injection. Defaults to true.") }));
var are = T(() => l.strictObject({ name: l.string().min(1).describe("Identifier for this monitor, unique within the plugin. Used to dedupe so re-arming (plugin reload, repeat skill invoke) does not spawn duplicates."), command: l.string().min(1).describe('Shell command to run as a persistent background monitor. Each stdout line is delivered to the model as a <task_notification> event; the process runs for the session lifetime. ${CLAUDE_PLUGIN_ROOT}, ${CLAUDE_PLUGIN_DATA}, ${CLAUDE_PROJECT_DIR}, ${user_config.*}, and ${ENV_VAR} are substituted. Runs in the session cwd \u2014 prefix with `cd "${CLAUDE_PLUGIN_ROOT}" && ` if the script needs its own directory.'), description: l.string().min(1).describe("Short human-readable description of what is being monitored (shown in task panel and notification summary)."), when: l.union([l.literal("always"), l.string().startsWith("on-skill-invoke:").refine((e) => e.length > 16, { message: "on-skill-invoke: must specify a skill name" })]).default("always").describe('Arm trigger. "always" arms at session start and on plugin reload. "on-skill-invoke:<skill>" arms the first time that skill is dispatched (via Skill tool or slash command).') }));
var cre = T(() => l.array(are()).refine((e) => new Set(e.map((t) => t.name)).size === e.length, { message: "Monitor names must be unique within a plugin" }));
var pU = T(() => l.object({ monitors: l.union([Ko().describe("Path to a JSON file containing the monitors array, relative to the plugin root"), cre()]).describe("Background watch scripts the host arms as persistent Monitor tasks (unsandboxed, same trust tier as hooks) so plugins need not instruct the model to arm them. When omitted, monitors/monitors.json at the plugin root is loaded if present.") }));
var lre = T(() => l.object({ lspServers: l.union([Ko().describe("Path to .lsp.json configuration file relative to plugin root"), l.record(l.string(), sU()).describe("LSP server configurations keyed by server name"), l.array(l.union([Ko().describe("Path to LSP configuration file"), l.record(l.string(), sU()).describe("Inline LSP server configurations")])).describe("Array of LSP server configurations (paths or inline definitions)")]) }));
var fU = T(() => l.string().refine((e) => !e.includes("..") && !e.includes("//"), "Package name cannot contain path traversal patterns").refine((e) => {
  let t = /^@[a-z0-9][a-z0-9-._]*\/[a-z0-9][a-z0-9-._]*$/, r = /^[a-z0-9][a-z0-9-._]*$/;
  return t.test(e) || r.test(e);
}, "Invalid npm package name format"));
var ure = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9_-])?$/;
var dre = /^[0-9a-f]{64}$/;
var pre = T(() => l.object({ sha256: l.string().regex(dre) }));
function fre(e) {
  let t = l.record(l.string(), l.unknown()).safeParse(e);
  if (!t.success) return;
  let r = /* @__PURE__ */ Object.create(null);
  for (let [o, n] of Object.entries(t.data)) {
    let i = pre().safeParse(n);
    if (ure.test(o) && i.success) r[o] = i.data;
  }
  return Object.keys(r).length > 0 ? r : void 0;
}
var mre = T(() => l.object({ binaries: l.unknown().transform(fre).describe("sha256-pinned files to fetch into bin/ at install time, keyed by basename (target triple encoded in the name)") }));
var gre = T(() => l.object({ settings: l.record(l.string(), l.unknown()).optional().describe("Settings to merge into the user settings while this plugin is enabled. Only the documented allowlisted keys are applied.") }));
var hre = T(() => l.object({ experimental: l.preprocess((e) => typeof e === "object" && e !== null && !Array.isArray(e) ? e : void 0, l.object({ ...uU().partial().shape, ...pU().partial().shape, ...lU().partial().shape, evals: l.union([l.string(), l.array(l.string())]).optional().describe("Path(s) to evaluation query files for `claude plugin eval`. Defaults to `evals/`.") }).passthrough().optional().describe("Components whose manifest shape may change without a deprecation cycle. Move a key out of here once it is promoted to stable.")) }));
var yre = T(() => l.object({ ...Jte().shape, ...Xte().partial().shape, ...Qte().partial().shape, ...ere().partial().shape, ...tre().partial().shape, ...lU().partial().shape, ...uU().partial().shape, ...rre().shape, ...sre().partial().shape, ...ore().partial().shape, ...lre().partial().shape, ...pU().partial().shape, ...gre().partial().shape, ...ire().partial().shape, ...mre().partial().shape, ...hre().partial().shape }));
var mu = T(() => l.discriminatedUnion("source", [l.object({ source: l.literal("url"), url: l.string().url().describe("Direct URL to marketplace.json file"), headers: l.record(l.string(), l.string()).optional().describe("Custom HTTP headers (e.g., for authentication)") }), l.object({ source: l.literal("github"), repo: l.string().describe("GitHub repository in owner/repo format"), ref: l.string().optional().describe('Git branch or tag to use (e.g., "main", "v1.0.0"). Defaults to repository default branch.'), path: l.string().optional().describe("Path to marketplace.json within repo (defaults to .claude-plugin/marketplace.json)"), sparsePaths: l.array(l.string()).optional().describe('Directories to include via git sparse-checkout (cone mode). Use for monorepos where the marketplace lives in a subdirectory. Example: [".claude-plugin", "plugins"]. If omitted, the full repository is cloned.'), skipLfs: l.boolean().optional().describe("Skip Git LFS smudge during clone and update (sets GIT_LFS_SKIP_SMUDGE=1) so LFS pointer files stay as pointers instead of downloading their content. Use for marketplaces hosted in repos with large LFS objects.") }), l.object({ source: l.literal("git"), url: l.string().describe("Full git repository URL"), ref: l.string().optional().describe('Git branch or tag to use (e.g., "main", "v1.0.0"). Defaults to repository default branch.'), path: l.string().optional().describe("Path to marketplace.json within repo (defaults to .claude-plugin/marketplace.json)"), sparsePaths: l.array(l.string()).optional().describe('Directories to include via git sparse-checkout (cone mode). Use for monorepos where the marketplace lives in a subdirectory. Example: [".claude-plugin", "plugins"]. If omitted, the full repository is cloned.'), skipLfs: l.boolean().optional().describe("Skip Git LFS smudge during clone and update (sets GIT_LFS_SKIP_SMUDGE=1) so LFS pointer files stay as pointers instead of downloading their content. Use for marketplaces hosted in repos with large LFS objects.") }), l.object({ source: l.literal("npm"), package: fU().describe("NPM package containing marketplace.json") }), l.object({ source: l.literal("file"), path: l.string().describe("Local file path to marketplace.json") }), l.object({ source: l.literal("directory"), path: l.string().describe("Local directory containing .claude-plugin/marketplace.json") }), l.object({ source: l.literal("skills-dir") }).describe("Policy-list sentinel for the ~/.claude/skills/ auto-load (@skills-dir plugins). In strictKnownMarketplaces: opt the scan back IN (by default any allowlist blocks it). In blockedMarketplaces: turn the scan OFF without otherwise restricting marketplaces. Only meaningful in those two managed-settings lists (areLocalPluginDirsAllowedByPolicy); known_marketplaces.json / marketplace add etc. ignore it."), l.object({ source: l.literal("hostPattern"), hostPattern: l.string().describe('Regex pattern to match the host/domain extracted from any marketplace source type. For github sources, matches against github.com. For git sources (SSH or HTTPS), extracts the hostname from the URL. Use in strictKnownMarketplaces to allow all marketplaces from a specific host (e.g., "^github\\.mycompany\\.com$").') }), l.object({ source: l.literal("pathPattern"), pathPattern: l.string().describe('Regex pattern matched against the .path field of file and directory sources. Use in strictKnownMarketplaces to allow filesystem-based marketplaces alongside hostPattern restrictions for network sources. Use ".*" to allow all filesystem paths, or a narrower pattern (e.g., "^/opt/approved/") to restrict to specific directories.') }), l.object({ source: l.literal("settings"), name: cU().refine((e) => !aU.has(e.toLowerCase()), { message: "Reserved marketplace names cannot be used with settings sources. validateOfficialNameSource only accepts github/git sources from anthropics/* for these names; a settings source would be rejected after loadAndCacheMarketplace has already written to disk with cleanupNeeded=false." }).describe("Marketplace name. Must match the extraKnownMarketplaces key (enforced); the synthetic manifest is written under this name. Same validation as PluginMarketplaceSchema plus reserved-name rejection \u2014 validateOfficialNameSource runs after the disk write, too late to clean up."), plugins: l.array(bre()).describe("Plugin entries declared inline in settings.json"), owner: Gx().optional() }).describe("Inline marketplace manifest defined directly in settings.json. The reconciler writes a synthetic marketplace.json to the cache; diffMarketplaces detects edits via isEqual on the stored source (the plugins array is inside this object, so edits surface as sourceChanged).")]));
var Zx = T(() => l.string().length(40).regex(/^[a-f0-9]{40}$/, "Must be a full 40-character lowercase git commit SHA"));
var mU = T(() => l.union([l.preprocess((e) => e === "." ? "./" : e, xr()).describe("Path to the plugin root, relative to the marketplace root (the directory containing .claude-plugin/, not .claude-plugin/ itself)"), l.object({ source: l.literal("npm"), package: fU().or(l.string().refine((e) => /^(?:file|https?|git(?:\+https?|\+ssh)?|ssh|github|gitlab|bitbucket):/i.test(e) || !e.includes(".."), 'Package reference cannot contain ".." path segments')).describe("Package name (or url, or local path, or anything else that can be passed to `npm` as a package)"), version: l.string().optional().describe("Specific version or version range (e.g., ^1.0.0, ~2.1.0)"), registry: l.string().url().optional().describe("Custom NPM registry URL (defaults to using system default, likely npmjs.org)") }).describe("NPM package as plugin source"), l.object({ source: l.literal("url"), url: l.string().describe("Full git repository URL (https:// or git@)"), ref: l.string().optional().describe('Git branch or tag to use (e.g., "main", "v1.0.0"). Defaults to repository default branch.'), sha: Zx().optional().describe("Specific commit SHA to use") }), l.object({ source: l.literal("github"), repo: l.string().describe("GitHub repository in owner/repo format"), ref: l.string().optional().describe('Git branch or tag to use (e.g., "main", "v1.0.0"). Defaults to repository default branch.'), sha: Zx().optional().describe("Specific commit SHA to use") }), l.object({ source: l.literal("git-subdir"), url: l.string().describe("Git repository: GitHub owner/repo shorthand, https://, or git@ URL"), path: l.string().min(1).describe('Subdirectory within the repo containing the plugin (e.g., "tools/claude-plugin"). Cloned sparsely using partial clone (--filter=tree:0) to minimize bandwidth for monorepos.'), ref: l.string().optional().describe('Git branch or tag to use (e.g., "main", "v1.0.0"). Defaults to repository default branch.'), sha: Zx().optional().describe("Specific commit SHA to use") }).describe("Plugin located in a subdirectory of a larger repository (monorepo). Only the specified subdirectory is materialized; the rest of the repo is not downloaded."), l.object({ source: l.literal("unsupported") }).describe('Placeholder for source types this Claude Code version does not recognize. Never authored by hand \u2014 PluginMarketplaceSchema rewrites unparseable sources to this so the entry remains in marketplace.plugins (detectDelistedPlugins must not see it as removed). Install attempts fail at cachePlugin with a clear "update Claude Code" message.')]));
var bre = T(() => l.object({ name: l.string().min(1, "Plugin name cannot be empty").refine((e) => !e.includes(" "), { message: 'Plugin name cannot contain spaces. Use kebab-case (e.g., "my-plugin")' }).describe("Plugin name as it appears in the target repository"), source: mU().describe("Where to fetch the plugin from. Must be a remote source \u2014 relative paths have no marketplace repository to resolve against."), description: l.string().optional(), version: l.string().optional(), strict: l.boolean().optional() }).refine((e) => typeof e.source !== "string", { message: 'Plugins in a settings-sourced marketplace must use remote sources (github, git-subdir, npm, url). Relative-path sources like "./foo" have no marketplace repository to resolve against.' }).refine((e) => typeof e.source === "string" || e.source.source !== "unsupported", { message: "source.source: 'unsupported' is a parse-time placeholder and cannot be authored. Use a remote source (github, git-subdir, npm, url)." }));
var _re = T(() => l.object({ cli: l.array(l.string().max(64)).max(10).optional().describe('First command tokens (e.g. ["stripe"]) \u2014 exact match against commands run this session.'), hosts: l.array(l.string().max(128)).max(20).optional().describe('Hostnames (e.g. ["api.stripe.com"]) \u2014 exact, case-insensitive match against hostnames seen in https?:// URLs in bash commands run this session. Bare hostname only: lowercase, no scheme, no port, no path.'), filesRead: l.array(l.string().max(256)).max(10).optional().describe('Glob patterns (e.g. ["**/*.tf"]) \u2014 the plugin is relevant when a file Claude has read this session matches any pattern. Matched against read-file paths, forward-slash normalized, case-insensitive.'), manifestDeps: l.array(l.object({ file: l.string().max(256), pattern: l.string().max(256) })).max(10).optional().describe("Dependency declared in a package manifest. Each {file, pattern} is a pair of RegExp sources: `file` matches the manifest filename (package.json, go.mod, requirements.txt, \u2026); `pattern` matches the dependency declaration inside that file. Evaluated against files read this session."), cwd: l.array(l.string().max(256)).max(10).optional().describe(`Glob patterns (e.g. ["Engine/Source/Runtime/Renderer/**"]) \u2014 the plugin is relevant when the session's working directory is at or under a directory matching the pattern. Matched against the cwd both relative to the enclosing git repo root and as an absolute path, forward-slash normalized, case-insensitive. A bare directory (no glob characters) means "cwd is at or under this directory". Known at session start, so this signal can surface a suggestion before the first turn.`) }));
var vre = T(() => l.object({ topic: l.string().max(64).optional().describe('What the user is working with when this plugin is relevant \u2014 fills "Working with {topic}?". Often the product name (e.g. "Stripe"); use a domain (e.g. "design") when the plugin name does not read naturally as a topic. Defaults to the plugin name with each hyphen-segment capitalized.'), signals: _re().optional().describe("Matchers that determine when the plugin is relevant.") }));
var Sre = T(() => yre().partial().extend({ name: l.string().min(1, "Plugin name cannot be empty").refine((e) => !e.includes(" "), { message: 'Plugin name cannot contain spaces. Use kebab-case (e.g., "my-plugin")' }).describe("Unique identifier matching the plugin name"), source: mU().describe("Where to fetch the plugin from"), category: l.string().optional().describe('Category for organizing plugins (e.g., "productivity", "development")'), tags: l.array(l.string()).optional().describe("Tags for searchability and discovery"), strict: l.boolean().optional().default(true).describe("Require the plugin manifest to be present in the plugin folder. If false, the marketplace entry provides the manifest."), relevance: l.preprocess((e) => typeof e === "object" && e !== null && !Array.isArray(e) ? e : void 0, vre().optional()).describe(`Declares when this plugin is relevant to the user's work. Consumed by the spinner tip ("Working with {topic}?"), session-start auto-suggest, and marketplace browse ranking.`) }));
var xre = T(() => l.object({ name: l.string().min(1).refine((e) => !e.includes(" ")) }));
function wre(e) {
  let t = Sre();
  return e.flatMap((r, o) => {
    let n = t.safeParse(r);
    if (n.success) return [n.data];
    let i = xre().safeParse(r).data?.name, s = n.error.issues.map((a) => `${a.path.join(".")}: ${a.message}`).join(", ");
    if (i) return ee(`Stubbing unparseable marketplace plugin entry (${i}): ${s}`, { level: "warn" }), [{ name: i, source: { source: "unsupported" }, strict: true }];
    return ee(`Dropping unparseable marketplace plugin entry (index ${o}): ${s}`, { level: "warn" }), [];
  });
}
var dOe = T(() => l.object({ $schema: l.string().optional().describe("JSON Schema reference for editor autocomplete/validation; ignored at load time"), name: cU(), version: l.string().optional().describe("Marketplace manifest version"), description: l.string().optional().describe("Human-readable description of this marketplace"), owner: Gx().describe("Marketplace maintainer or curator information"), plugins: l.array(l.unknown()).transform(wre).describe("Collection of available plugins in this marketplace"), forceRemoveDeletedPlugins: l.boolean().optional().describe("When true, plugins removed from this marketplace will be automatically uninstalled and flagged for users"), metadata: l.object({ pluginRoot: l.string().optional().describe("Base path for relative plugin sources"), version: l.string().optional().describe("Marketplace version"), description: l.string().optional().describe("Marketplace description") }).optional().describe("Optional marketplace metadata"), allowCrossMarketplaceDependenciesOn: l.array(l.string()).optional().describe("Marketplace names whose plugins may be auto-installed as dependencies. Only the root marketplace's allowlist applies \u2014 no transitive trust."), renames: l.record(l.string(), l.string().nullable()).optional().catch(void 0).describe("Append-only map of old plugin name \u2192 current name (or null when removed). The loader follows this on plugin-not-found and migrates user settings to the new name.") }));
var gU = T(() => l.string().regex(/^[A-Za-z0-9][-A-Za-z0-9._]*@[A-Za-z0-9][-A-Za-z0-9._]*$/, "Plugin ID must be in format: plugin@marketplace"));
var kre = /^[A-Za-z0-9][-A-Za-z0-9._]*(@[A-Za-z0-9][-A-Za-z0-9._]*)?(@\^[^@]*)?$/;
var Ere = T(() => l.union([l.string().regex(kre, "Dependency must be a plugin name, optionally qualified with @marketplace").transform((e) => e.replace(/@\^[^@]*$/, "")), l.object({ name: l.string().min(1).regex(/^[A-Za-z0-9][-A-Za-z0-9._]*$/), marketplace: l.string().min(1).regex(/^[A-Za-z0-9][-A-Za-z0-9._]*$/).optional() }).loose().transform((e) => e.marketplace ? `${e.name}@${e.marketplace}` : e.name)]));
var Pre = T(() => l.object({ version: l.string().describe("Currently installed version"), installedAt: l.string().describe("ISO 8601 timestamp of installation"), lastUpdated: l.string().optional().describe("ISO 8601 timestamp of last update"), installPath: l.string().describe("Absolute path to the installed plugin directory"), gitCommitSha: l.string().optional().describe("Git commit SHA for git-based plugins (for version tracking)"), resolvedVersion: l.string().optional().describe("Tag-derived semver this install resolved to (when fetched via a version constraint). Used by verifyAndDemote in preference to manifest.version, since the upstream may have forgotten to bump plugin.json."), auto: l.boolean().optional().describe("True when this plugin was pulled in as a dependency rather than installed explicitly. Auto-installed plugins are eligible for removal by the orphan sweep when nothing depends on them. Absent = manual (preserves pre-flag installs).") }));
var Tre = T(() => l.object({ version: l.literal(1).describe("Schema version 1"), plugins: l.record(gU(), Pre()).describe("Map of plugin IDs to their installation metadata") }));
var Ire = T(() => l.enum(["managed", "user", "project", "local"]));
var Rre = T(() => l.object({ scope: Ire().describe("Installation scope"), projectPath: l.string().optional().describe("Project path (required for project/local scopes)"), installPath: l.string().describe("Absolute path to the versioned plugin directory"), version: l.string().optional().describe("Currently installed version"), installedAt: l.string().optional().describe("ISO 8601 timestamp of installation"), lastUpdated: l.string().optional().describe("ISO 8601 timestamp of last update"), gitCommitSha: l.string().optional().describe("Git commit SHA for git-based plugins"), resolvedVersion: l.string().optional().describe("Tag-derived semver this install resolved to"), auto: l.boolean().optional().describe("True when pulled in as a dependency. Eligible for orphan sweep.") }));
var $re = T(() => l.object({ version: l.literal(2).describe("Schema version 2"), plugins: l.record(gU(), l.array(Rre())).describe("Map of plugin IDs to arrays of installation entries") }));
var pOe = T(() => l.union([Tre(), $re()]));
var Are = T(() => l.object({ source: mu().describe("Where to fetch the marketplace from"), installLocation: l.string().describe("Local cache path where marketplace manifest is stored"), lastUpdated: l.string().describe("ISO 8601 timestamp of last marketplace refresh"), autoUpdate: l.boolean().optional().describe("Whether to automatically update this marketplace and its installed plugins on startup") }));
var fOe = T(() => l.record(l.string(), Are()));
var Ore = ["autoMode", "deepLink", "voice", "briefView", "screenReader"];
var hg = {};
var yg = { autoMode: { buildGate: () => false, shape: () => hg, permissionsShape: () => hg, permissionModes: () => [] }, deepLink: { buildGate: () => true, shape: () => ({ disableDeepLinkRegistration: l.enum(["disable"]).optional().describe("Prevent claude-cli:// protocol handler registration with the OS") }) }, voice: { buildGate: () => false, shape: () => hg }, briefView: { buildGate: () => true, shape: () => ({ defaultView: l.enum(["chat", "transcript"]).optional().describe("Default transcript view: chat (SendUserMessage checkpoints only) or transcript (full)") }) }, screenReader: { buildGate: () => false, shape: () => hg } };
function Jx() {
  return Ore.filter((e) => yg[e].buildGate());
}
function hU(e) {
  let t = {};
  for (let r of e) t = { ...t, ...yg[r].shape() };
  return t;
}
function yU(e) {
  let t = {};
  for (let r of e) t = { ...t, ...yg[r].permissionsShape?.() };
  return t;
}
function bU(e) {
  let t = [];
  for (let r of e) t.push(...yg[r].permissionModes?.() ?? []);
  return t;
}
function Xx(e) {
  let t = e.split("__"), [r, o, ...n] = t;
  if (r !== "mcp" || !o) return null;
  let i = n.length > 0 ? n.join("__") : void 0;
  return { serverName: o, toolName: i };
}
var _U = { Task: "Agent", KillShell: "TaskStop", KillBash: "TaskStop", AgentOutputTool: "TaskOutput", BashOutputTool: "TaskOutput", AgentOutput: "TaskOutput", BashOutput: "TaskOutput", ListPeers: "ListAgents", Brief: "SendUserMessage", ListMcpResources: "ListMcpResourcesTool", ReadMcpResource: "ReadMcpResourceTool", ReadMcpResourceDir: "ReadMcpResourceDirTool" };
function Us(e) {
  return Object.hasOwn(_U, e) ? _U[e] : e;
}
var vU = "workspace";
var kOe = `mcp__${vU}__bash`;
var EOe = `mcp__${vU}__web_fetch`;
function Yx(e) {
  return e.includes("*");
}
function Cre(e) {
  return e.replaceAll("\\(", "(").replaceAll("\\)", ")").replaceAll("\\\\", "\\");
}
function SU(e) {
  let t = Mre(e, "(");
  if (t === -1) return { toolName: Us(e) };
  let r = Dre(e, ")");
  if (r === -1 || r <= t) return { toolName: Us(e) };
  if (r !== e.length - 1) return { toolName: Us(e) };
  let o = e.substring(0, t), n = e.substring(t + 1, r);
  if (!o) return { toolName: Us(e) };
  if (n === "" || n === "*") return { toolName: Us(o) };
  let i = Cre(n);
  return { toolName: Us(o), ruleContent: i };
}
function Mre(e, t) {
  for (let r = 0; r < e.length; r++) if (e[r] === t) {
    let o = 0, n = r - 1;
    while (n >= 0 && e[n] === "\\") o++, n--;
    if (o % 2 === 0) return r;
  }
  return -1;
}
function Dre(e, t) {
  for (let r = e.length - 1; r >= 0; r--) if (e[r] === t) {
    let o = 0, n = r - 1;
    while (n >= 0 && e[n] === "\\") o++, n--;
    if (o % 2 === 0) return r;
  }
  return -1;
}
var bg = { filePatternTools: ["Read", "Write", "Edit", "Glob", "NotebookRead", "NotebookEdit", "Cd"], bashPrefixTools: ["Bash"], customValidation: { WebSearch: (e) => {
  if (e.includes("*") || e.includes("?")) return { valid: false, error: "WebSearch does not support wildcards", suggestion: "Use exact search terms without * or ?", examples: ["WebSearch(claude ai)", "WebSearch(typescript tutorial)"] };
  return { valid: true };
}, WebFetch: (e) => {
  if (e.includes("://") || e.startsWith("http")) return { valid: false, error: "WebFetch permissions use domain format, not URLs", suggestion: 'Use "domain:hostname" format', examples: ["WebFetch(domain:example.com)", "WebFetch(domain:github.com)"] };
  if (!e.startsWith("domain:")) return { valid: false, error: 'WebFetch permissions must use "domain:" prefix', suggestion: 'Use "domain:hostname" format', examples: ["WebFetch(domain:example.com)", "WebFetch(domain:*.google.com)"] };
  return { valid: true };
} } };
function xU(e) {
  return bg.filePatternTools.includes(e);
}
function wU(e) {
  return bg.bashPrefixTools.includes(e);
}
function kU(e) {
  return Object.hasOwn(bg.customValidation, e) ? bg.customValidation[e] : void 0;
}
function PU(e, t) {
  let r = 0, o = t - 1;
  while (o >= 0 && e[o] === "\\") r++, o--;
  return r % 2 !== 0;
}
function Qx(e, t) {
  let r = 0;
  for (let o = 0; o < e.length; o++) if (e[o] === t && !PU(e, o)) r++;
  return r;
}
function Nre(e) {
  for (let t = 0; t < e.length - 1; t++) if (e[t] === "(" && e[t + 1] === ")") {
    if (!PU(e, t)) return true;
  }
  return false;
}
function EU(e) {
  if (!Yx(e)) return null;
  let t = Xx(e);
  if (t && !Yx(t.serverName)) return null;
  return { valid: false, error: `Wildcard tool name "${e}" is not supported in allow rules`, suggestion: "An allow pattern must name the scope it widens \u2014 globs are permitted only in the tool position after a literal mcp__<server>__ prefix. Deny and ask rules accept wildcards anywhere", examples: ["mcp__puppeteer__*", "mcp__github__get_*"] };
}
function ew(e, t) {
  if (!e || e.trim() === "") return { valid: false, error: "Permission rule cannot be empty" };
  let r = Qx(e, "("), o = Qx(e, ")");
  if (r !== o) return { valid: false, error: "Mismatched parentheses", suggestion: "Ensure all opening parentheses have matching closing parentheses" };
  if (Nre(e)) {
    let a = e.substring(0, e.indexOf("("));
    if (!a) return { valid: false, error: "Empty parentheses with no tool name", suggestion: "Specify a tool name before the parentheses" };
    return { valid: false, error: "Empty parentheses", suggestion: `Either specify a pattern or use just "${a}" without parentheses`, examples: [`${a}`, `${a}(some-pattern)`] };
  }
  let n = SU(e), i = Xx(n.toolName);
  if (i) {
    if (n.ruleContent !== void 0 || Qx(e, "(") > 0) return { valid: false, error: "MCP rules do not support patterns in parentheses", suggestion: `Use "${n.toolName}" without parentheses, or use "mcp__${i.serverName}__*" for all tools`, examples: [`mcp__${i.serverName}`, `mcp__${i.serverName}__*`, i.toolName && i.toolName !== "*" ? `mcp__${i.serverName}__${i.toolName}` : void 0].filter(Boolean) };
    if (t === "allow") {
      let a = EU(n.toolName);
      if (a) return a;
    }
    return { valid: true };
  }
  if (!n.toolName || n.toolName.length === 0) return { valid: false, error: "Tool name cannot be empty" };
  if (t === "allow") {
    let a = EU(n.toolName);
    if (a) return a;
  }
  if (!n.toolName.includes("_") && n.toolName[0] !== n.toolName[0]?.toUpperCase()) return { valid: false, error: "Tool names must start with uppercase", suggestion: `Use "${$h(String(n.toolName))}"` };
  let s = kU(n.toolName);
  if (s && n.ruleContent !== void 0) {
    let a = s(n.ruleContent);
    if (!a.valid) return a;
  }
  if (wU(n.toolName) && n.ruleContent !== void 0) {
    let a = n.ruleContent;
    if (a.includes(":*") && !a.endsWith(":*")) return { valid: false, error: "The :* pattern must be at the end", suggestion: "Move :* to the end for prefix matching, or use * for wildcard matching", examples: ["Bash(npm run:*) - prefix matching (legacy)", "Bash(npm run *) - wildcard matching"] };
    if (a === ":*") return { valid: false, error: "Prefix cannot be empty before :*", suggestion: "Specify a command prefix before :*", examples: ["Bash(npm *)", "Bash(git *)"] };
  }
  if (xU(n.toolName) && n.ruleContent !== void 0) {
    if (n.ruleContent.includes(":*")) return { valid: false, error: 'The ":*" syntax is only for Bash prefix rules', suggestion: 'Use glob patterns like "*" or "**" for file matching', examples: [`${n.toolName}(*.ts) - matches .ts files`, `${n.toolName}(src/**) - matches all files in src`, `${n.toolName}(**/*.test.ts) - matches test files`] };
  }
  return { valid: true };
}
var tw = T(() => IU());
var TU = T(() => IU("allow"));
function IU(e) {
  return l.string().superRefine((t, r) => {
    let o = ew(t, e);
    if (!o.valid) {
      let n = o.error;
      if (o.suggestion) n += `. ${o.suggestion}`;
      if (o.examples && o.examples.length > 0) n += `. Examples: ${o.examples.join(", ")}`;
      r.addIssue({ code: l.ZodIssueCode.custom, message: n, params: { received: t } });
    }
  });
}
var jre = T(() => l.record(l.string(), l.coerce.string()));
function CU(e) {
  return l.object({ allow: l.array(TU()).optional().describe("List of permission rules for allowed operations"), deny: l.array(tw()).optional().describe("List of permission rules for denied operations"), ask: l.array(tw()).optional().describe("List of permission rules that should always prompt for confirmation"), defaultMode: l.enum([...pu, ...bU(e)]).optional().describe("Default permission mode when Claude Code needs access"), disableBypassPermissionsMode: l.enum(["disable"]).optional().describe("Disable the ability to bypass permission prompts"), ...yU(e), additionalDirectories: l.array(l.string()).optional().describe("Additional directories to include in the permission scope") }).passthrough();
}
var ZOe = T(() => CU(Jx()));
var Ure = T(() => l.object({ source: mu().describe("Where to fetch the marketplace from"), installLocation: l.string().optional().describe("Local cache path where marketplace manifest is stored (auto-generated if not provided)"), autoUpdate: l.boolean().optional().describe("Whether to automatically update this marketplace and its installed plugins on startup") }));
var _g = T(() => l.object({ serverName: l.string().regex(/^[a-zA-Z0-9_-]+$/, "Server name can only contain letters, numbers, hyphens, and underscores").optional().describe("Name of the MCP server that users are allowed to configure"), serverCommand: l.array(l.string()).min(1, "Server command must have at least one element (the command)").optional().describe("Command array [command, ...args] to match exactly for allowed stdio servers"), serverUrl: l.string().optional().describe('URL pattern with wildcard support (e.g., "https://*.example.com/*") for allowed remote MCP servers') }).refine((e) => Jy([e.serverName !== void 0, e.serverCommand !== void 0, e.serverUrl !== void 0], Boolean) === 1, { message: 'Entry must have exactly one of "serverName", "serverCommand", or "serverUrl"' }));
var vg = T(() => l.object({ serverName: l.string().min(1, "Server name must be non-empty").refine((e) => e.trim().length > 0, { message: "Server name must not be whitespace-only" }).refine((e) => e === e.trim(), { message: "Server name has leading or trailing whitespace and will never match (names are compared verbatim)" }).optional().describe("Name of the MCP server that is explicitly blocked"), serverCommand: l.array(l.string()).min(1, "Server command must have at least one element (the command)").optional().describe("Command array [command, ...args] to match exactly for blocked stdio servers"), serverUrl: l.string().optional().describe('URL pattern with wildcard support (e.g., "https://*.example.com/*") for blocked remote MCP servers') }).refine((e) => Jy([e.serverName !== void 0, e.serverCommand !== void 0, e.serverUrl !== void 0], Boolean) === 1, { message: 'Entry must have exactly one of "serverName", "serverCommand", or "serverUrl"' }));
var zre = T(() => l.object({ path: l.string().describe("Absolute path to the helper executable"), timeoutMs: l.number().int().min(1e3).optional(), refreshIntervalMs: l.union([l.literal(0), l.number().int().min(6e4)]).optional() }));
var RU = ["skills", "agents", "hooks", "mcp"];
var $U = Object.freeze({ type: "invalid-entry-stripped" });
var Lre = T(() => l.union([l.object({ type: l.literal("regex").describe('Config variant. This client understands "regex": matches turn output and builds a URL from named capture groups. Entries with other variants are preserved but skipped at runtime.'), pattern: l.string().describe("Regex matched against turn output (tool results and assistant text)"), url: l.string().describe("Link target. {name} placeholders are filled from named regex capture groups, e.g. (?<id>...) -> {id}. Values are URL-encoded; the origin must be literal in the template. The scheme must be https, http, or a recognized editor or workspace deep-link scheme: vscode, vscode-insiders, cursor, windsurf, zed, jetbrains, idea, slack, linear, notion, figma."), label: l.string().optional().describe("Badge text. {name} placeholders filled from named capture groups; defaults to the full match.") }).passthrough(), l.object({ type: l.string().describe("Config variant discriminator for entries this client does not understand; the entry is preserved as-is and skipped at runtime.") }).passthrough()]));
function MU(e) {
  return l.object({ $schema: l.string().optional().describe("JSON Schema reference for Claude Code settings"), apiKeyHelper: l.string().optional().describe("Path to a script that outputs authentication values"), proxyAuthHelper: l.string().optional().describe("Shell command that outputs a Proxy-Authorization header value (EAP)"), awsCredentialExport: l.string().optional().describe("Path to a script that exports AWS credentials"), awsAuthRefresh: l.string().optional().describe("Path to a script that refreshes AWS authentication"), gcpAuthRefresh: l.string().optional().describe("Command to refresh GCP authentication (e.g., gcloud auth application-default login)"), policyHelper: zre().optional().describe("Executable that computes managed settings at startup. Honored only from admin-controlled policy sources."), ...Ee(process.env.CLAUDE_CODE_ENABLE_XAA) && { xaaIdp: l.object({ issuer: l.string().url().describe("IdP issuer URL for OIDC discovery"), clientId: l.string().describe("Claude Code's client_id registered at the IdP"), callbackPort: l.number().int().positive().optional().describe("Fixed loopback callback port for the IdP OIDC login. Only needed if the IdP does not honor RFC 8252 port-any matching.") }).optional().describe("XAA (SEP-990) IdP connection. Configure once; all XAA-enabled MCP servers reuse this.") }, fileSuggestion: l.object({ type: l.literal("command"), command: l.string() }).optional().describe("Custom file suggestion configuration for @ mentions"), respectGitignore: l.boolean().optional().describe("Whether file picker should respect .gitignore files (default: true). Note: .ignore files are always respected."), breakReminder: l.object({ enabled: l.boolean().optional().describe("Show a friendly nudge after sustained continuous use (default false). Must be true for the reminder to fire."), intervalMinutes: l.number().int().positive().optional().describe("Minutes of continuous use before the reminder fires (default 120). Re-fires every interval until you take a break."), breakThresholdMinutes: l.number().int().positive().optional().describe("Minutes of inactivity that count as a break and reset the timer (default 15)"), message: l.string().optional().describe("Custom reminder text. Leave unset for a rotating set of friendly nudges.") }).optional().describe("@internal Opt-in break reminder. When enabled, shows a dismissible nudge after sustained continuous use. Never blocks \u2014 just a friendly heads-up."), quietHours: l.object({ enabled: l.boolean().optional().describe("Show a one-time nudge when you start or keep using the CLI inside your quiet-hours window (default false)."), start: l.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'Expected 24-hour local time "HH:MM" (e.g. "22:00")').optional().describe('Start of the quiet-hours window, 24-hour local time "HH:MM".'), end: l.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'Expected 24-hour local time "HH:MM" (e.g. "07:00")').optional().describe('End of the quiet-hours window, 24-hour local time "HH:MM". May be earlier than start for an overnight range.') }).optional().describe("@internal Opt-in quiet hours. When enabled, shows a single soft nudge per session while inside the configured local-time window. Never blocks."), cleanupPeriodDays: l.number().int().positive().optional().describe("Number of days to retain chat transcripts before automatic cleanup (default: 30). Minimum 1. Use a large value for long retention; use --no-session-persistence to disable transcript writes entirely."), skillListingMaxDescChars: l.number().int().positive().optional().describe("Per-skill description character cap in the skill listing sent to Claude (default: 1536). Descriptions longer than this are truncated. Raise to opt in to higher per-turn context cost."), skillListingBudgetFraction: l.number().gt(0).lte(1).optional().describe("Fraction of the context window (in characters) reserved for the skill listing sent to Claude (default: 0.01 = 1%). When the listing exceeds this, descriptions are shortened to fit. Raise to opt in to higher per-turn context cost."), wslInheritsWindowsSettings: l.boolean().optional().describe("When set to true in either admin-only Windows source \u2014 the HKLM SOFTWARE/Policies/ClaudeCode registry key or C:/Program Files/ClaudeCode/managed-settings.json \u2014 WSL reads managed settings from the full Windows policy chain (HKLM, C:/Program Files/ClaudeCode via DrvFs, HKCU) in addition to /etc/claude-code. Windows sources take priority. The flag is also required in HKCU itself for HKCU policy to apply on WSL (double opt-in: admin enables the chain, user confirms HKCU). On native Windows the flag has no effect."), env: jre().optional().describe("Environment variables to set for Claude Code sessions"), attribution: l.object({ commit: l.string().optional().describe("Attribution text for git commits, including any trailers. Empty string hides attribution."), pr: l.string().optional().describe("Attribution text for pull request descriptions. Empty string hides attribution."), sessionUrl: l.boolean().optional().describe("Whether to append the claude.ai session link to commits and PRs created from web or Remote Control sessions (default: true). Set to false to omit the Claude-Session trailer and PR-body link.") }).optional().describe("Customize attribution text for commits and PRs. Each field defaults to the standard Claude Code attribution if not set."), includeCoAuthoredBy: l.boolean().optional().describe("Deprecated: Use attribution instead. Whether to include Claude's co-authored by attribution in commits and PRs (defaults to true)"), ...false, includeGitInstructions: l.boolean().optional().describe("Include built-in commit and PR workflow instructions in Claude's system prompt (default: true)"), permissions: CU(e).optional().describe("Tool usage permissions configuration"), model: l.string().optional().describe("Override the default model used by Claude Code"), fallbackModel: l.array(l.string()).optional().describe('Fallback model(s) tried in order when the primary model is overloaded or unavailable. Each element accepts a model name or alias; "default" expands to the default model. CLI --fallback-model takes precedence.'), availableModels: l.array(l.string()).optional().describe('Allowlist of models that users can select. Accepts family aliases ("opus" allows any opus version), version prefixes ("opus-4-5" allows only that version), and full model IDs. If undefined, all models are available. If empty array, only the default model is available. Typically set in managed settings by enterprise administrators.'), enforceAvailableModels: l.boolean().optional().describe("When true and availableModels is a non-empty array, the Default model selection is also constrained: if the default model for the user tier is not in availableModels, Default resolves to the first allowed availableModels entry instead. Has no effect when availableModels is unset or an empty array. Typically set in managed settings by enterprise administrators."), modelOverrides: l.record(l.string(), l.string()).optional().describe('Override mapping from Anthropic model ID (e.g. "claude-opus-4-6") to provider-specific model ID (e.g. a Bedrock inference profile ARN). Typically set in managed settings by enterprise administrators.'), enableAllProjectMcpServers: l.boolean().optional().describe("Whether to automatically approve all MCP servers in the project"), enabledMcpjsonServers: l.array(l.string()).optional().describe("List of approved MCP servers from .mcp.json"), disabledMcpjsonServers: l.array(l.string()).optional().describe("List of rejected MCP servers from .mcp.json"), disableClaudeAiConnectors: l.boolean().optional().describe("When true in any settings source, claude.ai MCP cloud connectors are not auto-fetched or connected. Only gates auto-fetched connectors \u2014 a claudeai-proxy server passed explicitly (e.g. via --mcp-config or the SDK mcpServers option) still follows the normal MCP config trust flow. Any-source-true wins: a project can opt out, but a project-level false cannot override a user-level true."), skillOverrides: l.record(l.string(), l.enum(["on", "name-only", "user-invocable-only", "off"])).optional().describe('Per-skill listing overrides keyed by skill name. "name-only" lists the skill without its description; "user-invocable-only" hides it from the model but keeps /name; "off" hides it from both. Absent = on.'), disableBundledSkills: l.boolean().optional().describe("Disable the skills and workflows that ship with Claude Code: bundled skills and workflows are removed entirely; built-in slash commands stay typable but are hidden from the model. Plugins, .claude/skills/, and .claude/commands/ are unaffected. Equivalent to CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1."), allowedMcpServers: l.array(_g()).optional().describe("Enterprise allowlist of MCP servers that can be used. Applies to all scopes including enterprise servers from managed-mcp.json. If undefined, all servers are allowed. If empty array, no servers are allowed. Denylist takes precedence - if a server is on both lists, it is denied."), deniedMcpServers: l.array(vg()).optional().describe("Enterprise denylist of MCP servers that are explicitly blocked. If a server is on the denylist, it will be blocked across all scopes including enterprise. Denylist takes precedence over allowlist - if a server is on both lists, it is denied."), hooks: Wo().optional().describe("Custom commands to run before/after tool executions"), worktree: l.object({ symlinkDirectories: l.array(l.string()).optional().describe('Directories to symlink from main repository to worktrees to avoid disk bloat. Must be explicitly configured - no directories are symlinked by default. Common examples: "node_modules", ".cache", ".bin"'), sparsePaths: l.array(l.string()).optional().describe("Directories to include when creating worktrees, via git sparse-checkout (cone mode). Dramatically faster in large monorepos \u2014 only the listed paths are written to disk."), baseRef: l.enum(["fresh", "head"]).optional().describe("Which ref new worktrees branch from. 'fresh' (default) branches from origin/<default-branch> for a clean tree. 'head' branches from your current local HEAD so unpushed commits and feature-branch state are present. Applies to --worktree, EnterWorktree, and agent isolation."), bgIsolation: l.enum(["worktree", "none"]).optional().catch(void 0).describe("Isolation mode for background sessions in this repo. 'worktree' (default) blocks Edit/Write in the main checkout until EnterWorktree is called. 'none' lets background jobs edit the working copy directly.") }).optional().describe("Git worktree configuration for --worktree flag."), disableAllHooks: l.boolean().optional().describe("Disable all hooks and statusLine execution"), disableAgentView: l.boolean().optional().describe("Disable agent view (`claude agents`, `--bg`, /background, the on-demand daemon). Typically set in managed settings. Equivalent to CLAUDE_CODE_DISABLE_AGENT_VIEW=1."), disableRemoteControl: l.boolean().optional().describe("Disable Remote Control (claude.ai/code, `claude remote-control`, `--remote-control`/`--rc`, auto-start, and the in-session toggle). Typically set in managed settings."), disableWorkflows: l.boolean().optional().describe("Disable the Workflows feature (also via CLAUDE_CODE_DISABLE_WORKFLOWS)."), disableArtifact: l.boolean().optional().describe("Disable the Artifact tool (also via CLAUDE_CODE_DISABLE_ARTIFACT)."), enableArtifact: l.boolean().optional().describe("Enable or disable the Artifact tool for this user. Unset = default by plan once the feature is available."), enableWorkflows: l.boolean().optional().describe("Enable or disable the Workflows feature for this user. Unset = default by plan once the feature is available."), workflowKeywordTriggerEnabled: l.boolean().optional().describe('Enable the "ultracode" keyword trigger: including the keyword in a prompt opts that turn into the Workflow tool. Set to false to disable the trigger. Default: true.'), disableSkillShellExecution: l.boolean().optional().describe("Disable inline shell execution in skills and custom slash commands from user, project, or plugin sources. Commands are replaced with a placeholder instead of being run."), defaultShell: l.enum(["bash", "powershell"]).optional().describe("Default shell for input-box ! commands. Defaults to 'bash' on all platforms (no Windows auto-flip)."), respondToBashCommands: l.boolean().optional().describe("Whether Claude responds after an input-box ! bash command runs. Set to false to add the command output to context without a response. Default: true."), allowManagedHooksOnly: l.boolean().optional().describe("When true (and set in managed settings), only hooks from managed settings run. User, project, and local hooks are ignored."), allowedHttpHookUrls: l.array(l.string()).optional().describe('Allowlist of URL patterns that HTTP hooks may target. Supports * as a wildcard (e.g. "https://hooks.example.com/*"). When set, HTTP hooks with non-matching URLs are blocked. If undefined, all URLs are allowed. If empty array, no HTTP hooks are allowed. Arrays merge across settings sources (same semantics as allowedMcpServers).'), httpHookAllowedEnvVars: l.array(l.string()).optional().describe("Allowlist of environment variable names HTTP hooks may interpolate into headers. When set, each hook's effective allowedEnvVars is the intersection with this list. If undefined, no restriction is applied. Arrays merge across settings sources (same semantics as allowedMcpServers)."), allowManagedPermissionRulesOnly: l.boolean().optional().describe("When true (and set in managed settings), only permission rules (allow/deny/ask) from managed settings are respected. User, project, local, and CLI argument permission rules are ignored."), allowManagedMcpServersOnly: l.boolean().optional().describe("When true (and set in managed settings), allowedMcpServers is only read from managed settings. deniedMcpServers still merges from all sources, so users can deny servers for themselves. Users can still add their own MCP servers, but only the admin-defined allowlist applies."), allowAllClaudeAiMcps: l.boolean().optional().describe("When true (and set in managed settings), claude.ai cloud MCP connectors load alongside managed-mcp.json instead of being suppressed by its exclusive-control lockdown. Default off preserves the lockdown. Read from managed settings only."), strictPluginOnlyCustomization: l.preprocess((t) => Array.isArray(t) ? t.filter((r) => RU.includes(r)) : t, l.union([l.boolean(), l.array(l.enum(RU))])).optional().catch(void 0).describe('When set in managed settings, blocks non-plugin customization sources for the listed surfaces. Array form locks specific surfaces (e.g. ["skills", "hooks"]); `true` locks all four; `false` is an explicit no-op. Blocked: ~/.claude/{surface}/, .claude/{surface}/ (project), settings.json hooks, .mcp.json. NOT blocked: managed (policySettings) sources, plugin-provided customizations. Composes with strictKnownMarketplaces for end-to-end admin control \u2014 plugins gated by marketplace allowlist, everything else blocked here.'), statusLine: l.object({ type: l.literal("command"), command: l.string(), padding: l.number().optional(), refreshInterval: l.number().min(1).optional().catch(void 0).describe("Re-run the status line command every N seconds in addition to event-driven updates"), hideVimModeIndicator: l.boolean().optional().describe("Hide the built-in `-- INSERT --` / `-- VISUAL --` indicator below the prompt. Use this when your status line script renders `vim.mode` itself.") }).optional().describe("Custom status line display configuration"), prUrlTemplate: l.string().optional().describe('URL template for PR links in the footer link badges and inline messages. The detected git PR is rendered as the first footer-link badge. Placeholders: {host} {owner} {repo} {number} {url}. Example: "https://reviews.example.com/{owner}/{repo}/pull/{number}"'), footerLinksRegexes: l.array(Lre().catch($U)).transform((t) => t.filter((r) => r !== $U)).optional().catch(void 0).describe("Extra clickable footer badges that appear when a regex matches turn output (tool results and assistant responses). Read from user, flag, and managed settings only; ignored in project .claude/settings.json and local .claude/settings.local.json. At most 5 badges render; the oldest is displaced by newer matches and /clear removes them. Use to surface IDs printed by project CLIs as session links."), subagentStatusLine: l.object({ type: l.literal("command"), command: l.string() }).optional().describe("Custom per-subagent status line shown in the agent panel; receives row context as JSON on stdin"), enabledPlugins: l.record(l.string(), l.union([l.array(l.string()), l.boolean(), l.undefined()])).optional().describe('Enabled plugins using plugin-id@marketplace-id format. Example: { "formatter@anthropic-tools": true }. Also supports extended format with version constraints. Settings precedence is user < project < local < flag < policy, so to disable a plugin that project settings enable, set it to false in .claude/settings.local.json \u2014 setting false in ~/.claude/settings.json is overridden by the project.'), extraKnownMarketplaces: l.record(l.string(), Ure()).check((t) => {
    for (let [r, o] of Object.entries(t.value)) if (o.source.source === "settings" && o.source.name !== r) t.issues.push({ code: "custom", input: o.source.name, path: [r, "source", "name"], message: `Settings-sourced marketplace name must match its extraKnownMarketplaces key (got key "${r}" but source.name "${o.source.name}")` });
  }).optional().describe("Additional marketplaces to make available for this repository. Typically used in repository .claude/settings.json to ensure team members have required plugin sources."), strictKnownMarketplaces: l.array(mu()).optional().describe("Enterprise strict list of allowed marketplace sources. When set in managed settings, ONLY these exact sources can be added as marketplaces. The check happens BEFORE downloading, so blocked sources never touch the filesystem. Note: this is a policy gate only \u2014 it does NOT register marketplaces. To pre-register allowed marketplaces for users, also set extraKnownMarketplaces."), blockedMarketplaces: l.array(mu()).optional().describe("Enterprise blocklist of marketplace sources. When set in managed settings, these exact sources are blocked from being added as marketplaces. The check happens BEFORE downloading, so blocked sources never touch the filesystem."), disableSideloadFlags: l.boolean().optional().describe("When true (and set in managed settings), rejects the --plugin-dir, --plugin-url, --agents, and non-sdk --mcp-config CLI flags at startup. Closes the CLI-flag bypass of strictKnownMarketplaces. Pair with allowedMcpServers for per-server MCP control; this setting does not gate other MCP entry points (SDK setMcpServers, claude mcp add, .mcp.json). Also blocks surfaces that spawn the CLI with these flags internally (see settings documentation). Only honored from managed settings; ignored in user/project/local settings."), pluginSuggestionMarketplaces: l.array(l.string()).optional().describe("Marketplace names whose plugins may surface as contextual install suggestions (relevance-based tips). No marketplace-declared suggestions surface without this allowlist; the built-in first-party frontend-design tip is unaffected. Only honored when set in managed settings (policy scope); the key is ignored in user, project, and local settings. A name only takes effect when the marketplace is registered on the machine AND its registered source is also declared in managed settings, either as the extraKnownMarketplaces entry for that name or as an entry of strictKnownMarketplaces. A marketplace registered from a different source under an allowlisted name is ignored. The official marketplace is exempt from the source requirement: allowlisting its name alone suffices, since that name can only register from the official Anthropic source."), forceLoginMethod: l.enum(["claudeai", "console", "gateway"]).optional().catch(void 0).describe('Force a specific login method: "claudeai" for Claude Pro/Max, "console" for Console billing, "gateway" for the Cloud gateway OIDC device flow'), forceLoginGatewayUrl: l.string().url().optional().catch(void 0).describe('@internal Cloud gateway URL to pre-fill and auto-connect to during login. Typically set in local managed settings alongside forceLoginMethod: "gateway" so users never type the URL. Hidden from public SDK types until Cloud gateway is documented.'), parentSettingsBehavior: l.enum(["first-wins", "merge"]).optional().describe(`Controls whether the SDK parent tier (Options.managedSettings / --managed-settings) layers under this admin tier. "first-wins" (default): parent is dropped \u2014 admin tiers are the only policy source. "merge": parent's restrictive-only-filtered settings union under the admin winner. Has no effect when no admin tier exists (parent applies as the sole policy tier, still filtered restrictive-only).`), forceLoginOrgUUID: l.union([l.string(), l.array(l.string())]).optional().describe("Organization UUID to require for OAuth login. Accepts a single UUID string or an array of UUIDs (any one is permitted). When set in managed settings, login fails if the authenticated account does not belong to a listed organization."), forceRemoteSettingsRefresh: l.boolean().optional().describe("When set in managed settings, the CLI blocks startup until remote managed settings are freshly fetched, and exits if the fetch fails"), otelHeadersHelper: l.string().optional().describe("Path to a script that outputs OpenTelemetry headers"), outputStyle: l.string().optional().describe("Controls the output style for assistant responses"), viewMode: l.enum(["default", "verbose", "focus"]).optional().catch(void 0).describe("Default transcript view mode on startup"), language: l.string().optional().describe('Preferred language for Claude responses and voice dictation (e.g., "japanese", "spanish")'), skipWebFetchPreflight: l.boolean().optional().describe("Skip the WebFetch blocklist check for enterprise environments with restrictive security policies"), sandbox: qx().optional(), feedbackSurveyRate: l.number().min(0).max(1).optional().describe("Probability (0\u20131) that the session quality survey appears when eligible. 0.05 is a reasonable starting point."), spinnerTipsEnabled: l.boolean().optional().describe("Whether to show tips in the spinner"), spinnerVerbs: l.object({ mode: l.enum(["append", "replace"]), verbs: l.array(l.string()) }).optional().describe('Customize spinner verbs. mode: "append" adds verbs to defaults, "replace" uses only your verbs.'), spinnerTipsOverride: l.object({ excludeDefault: l.boolean().optional(), tips: l.array(l.string()) }).optional().describe("Override spinner tips. tips: array of tip strings. excludeDefault: if true, only show custom tips (default: false)."), syntaxHighlightingDisabled: l.boolean().optional().describe("Whether to disable syntax highlighting in diffs"), terminalTitleFromRename: l.boolean().optional().describe("Whether /rename updates the terminal tab title (defaults to true). Set to false to keep auto-generated topic titles."), alwaysThinkingEnabled: l.boolean().optional().describe("When false, thinking is disabled. When absent or true, thinking is enabled automatically for supported models."), effortLevel: l.enum(["low", "medium", "high", "xhigh"]).optional().catch(void 0).describe("Persisted effort level for supported models."), ultracode: l.boolean().optional().catch(void 0).describe("Enable ultracode for the session: xhigh effort plus standing dynamic-workflow orchestration. Session-scoped \u2014 typically provided via --settings or the apply_flag_settings control request; interactive toggles never persist it. Requires workflows to be enabled and an xhigh-capable model."), autoCompactWindow: l.number().int().min(1e5).max(1e6).optional().catch(void 0).describe("Auto-compact window size"), advisorModel: l.string().optional().describe("Advisor model for the server-side advisor tool."), fastMode: l.boolean().optional().describe("When true, fast mode is enabled. When absent or false, fast mode is off."), fastModePerSessionOptIn: l.boolean().optional().describe("When true, fast mode does not persist across sessions. Each session starts with fast mode off."), promptSuggestionEnabled: l.boolean().optional().describe("When false, prompt suggestions are disabled. When absent or true, prompt suggestions are enabled."), awaySummaryEnabled: l.boolean().optional().describe("@internal When false, the session recap (shown when you return after being away for 5+ minutes) is disabled. When absent or true, recap is enabled. Hidden from public SDK types until external launch."), showClearContextOnPlanAccept: l.boolean().optional().describe('When true, the plan-approval dialog offers a "clear context" option. Defaults to false.'), agent: l.string().optional().describe("Name of an agent (built-in or custom) to use for the main thread. Applies the agent's system prompt, tool restrictions, and model."), companyAnnouncements: l.array(l.string()).optional().describe("Company announcements to display at startup (one will be randomly selected if multiple are provided)"), pluginConfigs: l.record(l.string(), l.object({ mcpServers: l.record(l.string(), l.record(l.string(), l.union([l.string(), l.number(), l.boolean(), l.array(l.string())]))).optional().describe("User configuration values for MCP servers keyed by server name"), options: l.record(l.string(), l.union([l.string(), l.number(), l.boolean(), l.array(l.string())])).optional().describe("Non-sensitive option values from plugin manifest userConfig, keyed by option name. Sensitive values go to secure storage instead.") }).or(l.undefined())).optional().describe("Per-plugin configuration including MCP server user configs, keyed by plugin ID (plugin@marketplace format)"), remote: l.object({ defaultEnvironmentId: l.string().optional().describe("Default environment ID to use for cloud sessions") }).optional().describe("Cloud session configuration"), autoUpdatesChannel: l.enum(["latest", "stable", "rc"]).optional().describe("Release channel for auto-updates (latest or stable)"), minimumVersion: l.string().optional().describe("Minimum version to stay on - prevents downgrades when switching to stable channel"), requiredMinimumVersion: l.string().optional().describe("Minimum Claude Code version required to start. If the running version is older, Claude Code exits at startup with instructions to update. Only enforced from managed (policy) settings."), requiredMaximumVersion: l.string().optional().describe("Maximum Claude Code version allowed to start. If the running version is newer, Claude Code exits at startup with instructions to install an approved version. Only enforced from managed (policy) settings."), plansDirectory: l.string().optional().describe("Custom directory for plan files, relative to project root. If not set, defaults to ~/.claude/plans/"), tui: l.enum(["default", "fullscreen"]).optional().describe('Terminal UI renderer. "fullscreen" uses the flicker-free alt-screen renderer with virtualized scrollback (equivalent to CLAUDE_CODE_NO_FLICKER=1). "default" uses the classic main-screen renderer.'), ...false, voice: l.object({ enabled: l.boolean().optional(), mode: l.enum(["hold", "tap"]).optional().describe("'hold' (default): hold to talk. 'tap': tap to start, tap to stop+submit."), autoSubmit: l.boolean().optional().describe("Submit the prompt when hold-to-talk is released (hold mode only)") }).optional().describe("Voice mode settings (hold-to-talk / tap-to-toggle dictation)"), channelsEnabled: l.boolean().optional().describe("Managed-org opt-in for channel notifications (MCP servers with the claude/channel capability pushing inbound messages). claude.ai Teams/Enterprise: default off. Console: default on unless managed settings exist. Set true to allow; users then select servers via --channels."), allowedChannelPlugins: l.array(l.object({ marketplace: l.string(), plugin: l.string() })).optional().describe("Managed-org allowlist of channel plugins. When set, replaces the default Anthropic allowlist \u2014 admins decide which plugins may push inbound messages. Undefined falls back to the default. Requires channelsEnabled: true."), prefersReducedMotion: l.boolean().optional().describe("Reduce or disable animations for accessibility (spinner shimmer, flash effects, etc.)"), doneMeansMerged: l.boolean().optional().describe("@internal When true, Claude keeps working until the PR is ready for you to merge, a cron/Monitor is armed to resume later, or it hands you a self-contained next step."), totalTokensReminder: l.enum(["off", "infinite", "fixed", "countdown", "padded-countdown"]).optional().describe("@internal Emit a <total_tokens>N tokens left</total_tokens> block in the system prompt and after each tool result. 'infinite' uses the literal value Infinite, 'fixed' uses 5000000, 'countdown' uses the live remaining context-window tokens, 'padded-countdown' counts down from totalTokensReminderBudget by per-agent cumulative context spend (monotonic across compaction and /clear). Defaults to off. Env var CLAUDE_CODE_TOTAL_TOKENS_REMINDER overrides."), totalTokensReminderBudget: l.number().int().positive().optional().describe("@internal Starting budget (tokens) for totalTokensReminder 'padded-countdown' mode. Defaults to 15000000. Server-controlled via GrowthBook; env var CLAUDE_CODE_TOTAL_TOKENS_REMINDER_BUDGET overrides."), autoMemoryEnabled: l.boolean().optional().describe("Enable auto-memory for this project. When false, Claude will not read from or write to the auto-memory directory."), autoMemoryDirectory: l.string().optional().describe("Custom directory path for auto-memory storage. Supports ~/ prefix for home directory expansion. Ignored if set in projectSettings (checked-in .claude/settings.json) for security. When unset, defaults to ~/.claude/projects/<sanitized-cwd>/memory/."), autoDreamEnabled: l.boolean().optional().describe("Enable background memory consolidation (auto-dream). When set, overrides the server-side default."), showThinkingSummaries: l.boolean().optional().describe("Request API-side thinking summaries and show them in the conversation and in the transcript view (ctrl+o). Set explicitly to override the default for your install."), skipDangerousModePermissionPrompt: l.boolean().optional().describe("Whether the user has accepted the bypass permissions mode dialog"), skipWorkflowUsageWarning: l.boolean().optional().describe("@internal Whether the user has accepted the multi-agent workflow usage warning. Until set, auto permission mode prompts before running a workflow."), disableAutoMode: l.enum(["disable"]).optional().describe("Disable auto mode"), sshConfigs: l.array(l.object({ id: l.string().describe("Unique identifier for this SSH config. Used to match configs across settings sources."), name: l.string().describe("Display name for the SSH connection"), sshHost: l.string().describe('SSH host in format "user@hostname" or "hostname", or a host alias from ~/.ssh/config'), sshPort: l.number().int().optional().describe("SSH port (default: 22)"), sshIdentityFile: l.string().optional().describe("Path to SSH identity file (private key)"), startDirectory: l.string().optional().describe("Default working directory on the remote host. Supports tilde expansion (e.g. ~/projects). If not specified, defaults to the remote user home directory. Can be overridden by the [dir] positional argument in `claude ssh <config> [dir]`.") })).optional().describe("SSH connection configurations for remote environments. Typically set in managed settings by enterprise administrators to pre-configure SSH connections for team members."), claudeMd: l.string().optional().describe("CLAUDE.md-style instructions injected as organization-managed memory. Only honored from managed/policy settings."), claudeMdExcludes: l.array(l.string()).optional().describe('Glob patterns or absolute paths of CLAUDE.md files to exclude from loading. Patterns are matched against absolute file paths using picomatch. Only applies to User, Project, and Local memory types (Managed/policy files cannot be excluded). Examples: "/home/user/monorepo/CLAUDE.md", "**/code/CLAUDE.md", "**/some-dir/.claude/rules/**"'), pluginTrustMessage: l.string().optional().describe('Custom message to append to the plugin trust warning shown before installation. Only read from policy settings (managed-settings.json / MDM). Useful for enterprise administrators to add organization-specific context (e.g., "All plugins from our internal marketplace are vetted and approved.").'), theme: l.union([l.enum(Xj), l.string().startsWith("custom:").transform((t) => t)]).optional().catch(void 0).describe("Color theme for the UI"), editorMode: l.enum(Gj).optional().catch(void 0).describe("Key binding mode for the prompt input"), verbose: l.boolean().optional().describe("Show full tool output instead of truncated summaries"), preferredNotifChannel: l.enum(Kj).optional().catch(void 0).describe("Preferred OS notification channel"), autoCompactEnabled: l.boolean().optional().describe("Automatically compact conversation when context fills"), precomputeCompactionEnabled: l.boolean().optional().describe("@internal Precompute the compaction summary in the background before it is needed. Only applies when auto-compact is on."), switchModelsOnFlag: l.boolean().optional().describe("When safety measures flag a message, automatically switch to a different model to keep chatting. When off, your session will pause instead."), autoScrollEnabled: l.boolean().optional().describe("Auto-scroll the conversation view to bottom (fullscreen mode only)"), wheelScrollAccelerationEnabled: l.boolean().optional().describe("Ramp mouse-wheel scroll speed during fast scrolls (fullscreen mode only)"), fileCheckpointingEnabled: l.boolean().optional().describe("Snapshot files before edits so /rewind can restore them"), showTurnDuration: l.boolean().optional().describe('Show "Cooked for Nm Ns" after each assistant turn'), showMessageTimestamps: l.boolean().optional().describe("Stamp each assistant message with its arrival time"), terminalProgressBarEnabled: l.boolean().optional().describe("Emit OSC 9;4 progress sequences during long operations"), todoFeatureEnabled: l.boolean().optional().describe("Enable the todo / task tracking panel"), teammateMode: l.enum(Jj).optional().catch(void 0).describe("How spawned teammates execute (tmux, iterm2, in-process, auto)"), remoteControlAtStartup: l.boolean().optional().describe("Start Remote Control bridge automatically each session"), isolatePeerMachines: l.boolean().optional().describe("Require explicit approval before SendMessage can reach a peer session on another machine via Remote Control"), daemonColdStart: l.enum(["transient", "ask"]).optional().describe("When no background service is running: 'transient' spawns one for this login session; 'ask' offers to install it persistently"), autoUploadSessions: l.boolean().optional().describe("Mirror local sessions to claude.ai as view-only (no remote control)"), inputNeededNotifEnabled: l.boolean().optional().describe("Push to mobile when a permission prompt or question is waiting"), agentPushNotifEnabled: l.boolean().optional().describe("Allow Claude to push proactive mobile notifications"), ...hU(e) }).passthrough();
}
var Jo = T(() => MU(Jx()));
var AU = Object.freeze({ serverName: "invalid-entry-stripped" });
var cn = "https://code.claude.com/docs/en";
var Fre = [{ matches: (e) => e.path === "permissions.defaultMode" && e.code === "invalid_value", tip: { suggestion: 'Valid modes: "acceptEdits" (ask before file changes), "plan" (analysis only), "bypassPermissions" (auto-accept all), or "default" (standard behavior)', docLink: `${cn}/iam#permission-modes` } }, { matches: (e) => e.path === "apiKeyHelper" && e.code === "invalid_type", tip: { suggestion: 'Provide a shell command that outputs your API key to stdout. The script should output only the API key. Example: "/bin/generate_temp_api_key.sh"' } }, { matches: (e) => e.path === "cleanupPeriodDays" && e.code === "too_small", tip: { suggestion: 'cleanupPeriodDays must be at least 1. To keep transcripts for a long time, set a large number (e.g. 3650 for ~10 years). To disable transcript writes entirely, remove this setting and use the --no-session-persistence CLI flag or the SDK persistSession:false option instead. (0 is rejected because it previously silently disabled all transcript writes, which users setting it to mean "never clean up" did not expect.)' } }, { matches: (e) => e.path.startsWith("env.") && e.code === "invalid_type", tip: { suggestion: 'Environment variables must be strings. Wrap numbers and booleans in quotes. Example: "DEBUG": "true", "PORT": "3000"', docLink: `${cn}/settings#environment-variables` } }, { matches: (e) => (e.path === "permissions.allow" || e.path === "permissions.deny") && e.code === "invalid_type" && e.expected === "array", tip: { suggestion: 'Permission rules must be in an array. Format: ["Tool(specifier)"]. Examples: ["Bash(npm run build)", "Edit(docs/**)", "Read(~/.zshrc)"]. Use * for wildcards.' } }, { matches: (e) => e.path.startsWith("hooks.") && e.code === "invalid_key", tip: { suggestion: "Not a recognized hook event. Common events: PreToolUse, PostToolUse, UserPromptSubmit, SessionStart, SessionEnd, Stop. Check spelling and capitalization.", docLink: `${cn}/hooks` } }, { matches: (e) => /\.hooks\.\d+\.command$/.test(e.path) && e.code === "invalid_type" && e.received === "undefined", tip: { suggestion: 'Command hooks require `command`. For exec form (no shell), set `command` to the executable and `args` to its arguments: {"type": "command", "command": "echo", "args": ["hi"]}. For shell form, set `command` to the full shell string: {"type": "command", "command": "echo hi"}.', docLink: `${cn}/hooks#exec-form-and-shell-form` } }, { matches: (e) => e.path.includes("hooks") && e.code === "invalid_type", tip: { suggestion: 'Hooks use a matcher + hooks array. The matcher is a string: a tool name ("Bash"), pipe-separated list ("Edit|Write"), or empty to match all. Example: {"PostToolUse": [{"matcher": "Edit|Write", "hooks": [{"type": "command", "command": "echo Done"}]}]}' } }, { matches: (e) => e.code === "invalid_type" && e.expected === "boolean", tip: { suggestion: 'Use true or false without quotes. Example: "includeCoAuthoredBy": true' } }, { matches: (e) => e.code === "unrecognized_keys", tip: { suggestion: "Check for typos or refer to the documentation for valid fields", docLink: `${cn}/settings` } }, { matches: (e) => e.code === "invalid_value" && e.enumValues !== void 0, tip: { suggestion: void 0 } }, { matches: (e) => e.code === "invalid_type" && e.expected === "object" && e.received === null && e.path === "", tip: { suggestion: "Check for missing commas, unmatched brackets, or trailing commas. Use a JSON validator to identify the exact syntax error." } }, { matches: (e) => e.path === "permissions.additionalDirectories" && e.code === "invalid_type", tip: { suggestion: 'Must be an array of directory paths. Example: ["~/projects", "/tmp/workspace"]. You can also use --add-dir flag or /add-dir command', docLink: `${cn}/iam#working-directories` } }];
var Hre = { permissions: `${cn}/iam#configuring-permissions`, env: `${cn}/settings#environment-variables`, hooks: `${cn}/hooks` };
var lCe = T(() => Jo().strict());
var Vre = new Set(ei);
var eo = Object.freeze({ settings: {}, errors: [] });
process.env.NoDefaultCurrentDirectoryInExePath = "1";
async function Cne(e, t) {
  try {
    await Pne(e, t);
  } catch (r) {
    if (!Fr(r)) throw r;
  }
}
async function Mne(e, t) {
  if (!e) return;
  let r = e;
  try {
    let o = Ze(e);
    if (o?.claudeAiOauth?.refreshToken) delete o.claudeAiOauth.refreshToken, r = pe(o);
  } catch {
  }
  await yz(t, r, { mode: 384 });
}
function Dne() {
  if (process.platform !== "darwin") return Promise.resolve(void 0);
  let e = UR(jR);
  return new Promise((t) => {
    wne("security", ["find-generic-password", "-a", zR(), "-w", "-s", e], { encoding: "utf-8", timeout: 5e3, windowsHide: true }, (r, o) => t(r ? void 0 : o.trim() || void 0));
  });
}
async function vz(e, t, r, o, n = 6e4) {
  if (!Se(t)) return;
  let i = or(r), s = await Mr(e.load({ projectKey: i, sessionId: t }), n, `SessionStore.load() timed out after ${n}ms for session ${t}`);
  if (!s || s.length === 0) return;
  let a = Lt($ne(), `claude-resume-${pw()}`);
  try {
    let c = Lt(a, "projects", i);
    await aw(c, { recursive: true });
    let u = Lt(c, `${t}.jsonl`);
    await ac(u, s);
    let d = o?.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR, p = d ?? Lt(cw(), ".claude"), f;
    try {
      f = await hz(Lt(p, ".credentials.json"), "utf-8");
    } catch (m) {
      if (!Fr(m)) throw m;
    }
    if (!d && !(o ?? process.env).ANTHROPIC_API_KEY && !(o ?? process.env).CLAUDE_CODE_OAUTH_TOKEN) f = await Dne() ?? f;
    if (await Mne(f, Lt(a, ".credentials.json")), await Cne(Lt(d ?? cw(), ".claude.json"), Lt(a, ".claude.json")), e.listSubkeys) {
      let m = Lt(c, t), g = await Mr(e.listSubkeys({ projectKey: i, sessionId: t }), n, `SessionStore.listSubkeys() timed out after ${n}ms for session ${t}`);
      for (let h of g) {
        let y = _u(m, h + ".jsonl");
        if (!h || bz(h) || h.split(/[\\/]/).includes("..") || !y.startsWith(m + fw)) {
          ee(`[SessionStore] skipping unsafe subpath from listSubkeys: ${h}`, { level: "warn" });
          continue;
        }
        let v = await Mr(e.load({ projectKey: i, sessionId: t, subpath: h }), n, `SessionStore.load() timed out after ${n}ms for session ${t} subpath ${h}`);
        if (!v || v.length === 0) continue;
        let w = [], x = [];
        for (let $ of v) if (dw($)) w.push($);
        else x.push($);
        if (x.length > 0) await aw(dz(y), { recursive: true }), await ac(y, x);
        if (w.length > 0) {
          let $ = w.at(-1), U = _u(m, h + ".meta.json");
          await aw(dz(U), { recursive: true });
          let { type: se, ...Le } = $;
          await yz(U, pe(Le), { mode: 384 });
        }
      }
    }
    return a;
  } catch (c) {
    throw await kg(a), c;
  }
}
function lw(e, t, r, o) {
  let { systemPrompt: n, settings: i, managedSettings: s, settingSources: a, sandbox: c, ...u } = e ?? {}, d, p, f;
  if (n === void 0) d = "";
  else if (typeof n === "string") d = n;
  else if (Array.isArray(n)) d = n;
  else if (n.type === "preset") p = n.append, f = n.excludeDynamicSections;
  process.env.CLAUDE_AGENT_SDK_VERSION = "0.3.197";
  let { abortController: m = Ks(), additionalDirectories: g = [], agent: h, agents: y, allowedTools: v = [], betas: w, canUseTool: x, continue: $, cwd: U, debug: se, debugFile: Le, disallowedTools: Ye = [], tools: Ft, env: _t, executable: to = ku() ? "bun" : "node", executableArgs: Yo = [], extraArgs: Ar = {}, fallbackModel: Fs, enableFileCheckpointing: ln, toolConfig: Z, forkSession: vu, hooks: Su, includeHookEvents: Hs, includePartialMessages: Bs, forwardSubagentText: qs, onElicitation: xu, onUserDialog: je, supportedDialogKinds: Ht, persistSession: wr, sessionStore: Or, sessionStoreFlush: Ez, thinking: Vs, effort: Pz, maxThinkingTokens: Pg, maxTurns: Tz, maxBudgetUsd: Iz, taskBudget: Rz, mcpServers: mw, model: $z, outputFormat: gw, permissionMode: Az = "default", allowDangerouslySkipPermissions: Oz = false, permissionPromptToolName: Cz, plugins: Mz, getOAuthToken: hw, getHostAuthToken: yw, workload: bw, resume: _w, resumeSessionAt: Dz, sessionId: Nz, skills: vw, stderr: jz, strictMcpConfig: Uz } = u;
  if (Or && wr === false) throw Error("sessionStore cannot be used with persistSession: false -- the storage adapter requires local writes to mirror from. Use CLAUDE_CONFIG_DIR=/tmp for ephemeral local writes with external mirroring.");
  if (Ht !== void 0 && Ht.length > 0 && !je) throw Error("supportedDialogKinds requires an onUserDialog callback -- declaring dialog kinds without a handler would park dialogs nothing can answer. Provide onUserDialog, or omit supportedDialogKinds.");
  if (Or && $ && !_w && !Or.listSessions) throw Error("Options.continue with sessionStore requires store.listSessions to be implemented");
  if (Or && ln) throw Error("enableFileCheckpointing is not yet supported with sessionStore (backup blobs are not mirrored, so rewindFiles() fails after a store-backed resume).");
  if (Or && u.spawnClaudeCodeProcess) ee("sessionStore with custom spawnClaudeCodeProcess: ensure the subprocess CLAUDE_CONFIG_DIR matches the parent (same path, same separators) or transcript_mirror frames will be dropped.", { level: "warn" });
  let Tg = u.pathToClaudeCodeExecutable;
  if (!Tg) {
    let At = One(import.meta.url), ir = Rne(At), ro = eT((Qo) => ir.resolve(Qo));
    if (!ro) throw Error(`Native CLI binary for ${process.platform}-${process.arch} not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable.`);
    Tg = ro;
  }
  let Sw = gw?.type === "json_schema" ? gw.schema : void 0, dt = _t ? { ..._t } : { ...process.env };
  if (!dt.CLAUDE_CODE_ENTRYPOINT) dt.CLAUDE_CODE_ENTRYPOINT = "sdk-ts";
  if (!dt.CLAUDE_AGENT_SDK_VERSION) dt.CLAUDE_AGENT_SDK_VERSION = "0.3.197";
  if (ln) dt.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = "true";
  if (hw) dt.CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH = "1";
  if (yw) dt.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH = "1";
  if (Z?.askUserQuestion?.previewFormat) dt.CLAUDE_CODE_QUESTION_PREVIEW_FORMAT = Z.askUserQuestion.previewFormat;
  let Ig = {};
  if (Eg.propagation.inject(Eg.context.active(), Ig), "traceparent" in Ig) {
    for (let At of ["TRACEPARENT", "TRACESTATE"]) if (!(At in (_t ?? {}))) delete dt[At];
  }
  for (let [At, ir] of Object.entries(Ig)) {
    let ro = At.toUpperCase();
    if (!(ro in (_t ?? {}))) dt[ro] = ir;
  }
  let xw = {}, ww = /* @__PURE__ */ new Map();
  if (mw) for (let [At, ir] of Object.entries(mw)) if (ir.type === "sdk" && ir.instance) ww.set(At, ir.instance);
  else xw[At] = ir;
  let Zs;
  if (Vs) switch (Vs.type) {
    case "adaptive":
      Zs = { type: "adaptive", display: Vs.display };
      break;
    case "enabled":
      Zs = { type: "enabled", budgetTokens: Vs.budgetTokens, display: Vs.display };
      break;
    case "disabled":
      Zs = { type: "disabled" };
      break;
  }
  else if (Pg !== void 0) Zs = Pg === 0 ? { type: "disabled" } : { type: "enabled", budgetTokens: Pg };
  if (r) {
    if (dt.CLAUDE_CONFIG_DIR = r, process.platform === "win32") dt.CLAUDE_SECURESTORAGE_CONFIG_DIR = _t?.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? _t?.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? "";
  }
  let kw = new Lh({ abortController: m, additionalDirectories: g, agent: h, betas: w, cwd: U, debug: se, debugFile: Le, executable: to, executableArgs: Yo, extraArgs: bw ? { ...Ar, workload: bw } : Ar, pathToClaudeCodeExecutable: Tg, env: dt, forkSession: vu, stderr: jz, thinkingConfig: Zs, effort: Pz, maxTurns: Tz, maxBudgetUsd: Iz, taskBudget: Rz, model: $z, fallbackModel: Fs, jsonSchema: Sw, permissionMode: Az, allowDangerouslySkipPermissions: Oz, permissionPromptToolName: Cz, continueConversation: Or ? void 0 : $, resume: _w, resumeSessionAt: Dz, sessionId: Nz, settings: typeof i === "object" ? pe(i) : i, managedSettings: s ? pe(s) : void 0, settingSources: a, skills: vw, allowedTools: v, disallowedTools: Ye, tools: Ft, mcpServers: xw, strictMcpConfig: Uz, canUseTool: !!x, hooks: !!Su, includeHookEvents: Hs, includePartialMessages: Bs, persistSession: wr, sessionMirror: !!Or, plugins: Mz, sandbox: c, spawnClaudeCodeProcess: u.spawnClaudeCodeProcess, deferSpawn: o }), zz = { systemPrompt: d, appendSystemPrompt: p, planModeInstructions: u.planModeInstructions, appendSubagentSystemPrompt: u.appendSubagentSystemPrompt, toolAliases: u.toolAliases, excludeDynamicSections: f, agents: y, title: u.title, skills: vw, webSearchIsolationExemptMcpServers: u.webSearchIsolationExemptMcpServers, promptSuggestions: u.promptSuggestions, agentProgressSummaries: u.agentProgressSummaries, forwardSubagentText: qs, supportedDialogKinds: Ht }, Rg = new qh(kw, t, x, Su, m, ww, Sw, zz, xu, hw, yw, je);
  if (Or) {
    let At = () => Lt(dt.CLAUDE_CONFIG_DIR ?? Lt(cw(), ".claude"), "projects"), ir = Ez === "eager", ro = new Vh(async (Qo, $g) => {
      let Ws = gz(Qo, At());
      if (Ws) await Or.append(Ws, $g);
      else ee(`[SessionStore] dropping mirror frame: filePath ${Qo} is not under ${At()} -- subprocess CLAUDE_CONFIG_DIR likely differs from parent (custom spawnClaudeCodeProcess / container?)`, { level: "warn" });
    }, void 0, (Qo, $g) => {
      let Ws = gz(Qo, At());
      if (Ws) Rg.reportMirrorError(Ws, $g.message);
    }, ir ? 0 : Pd, ir ? 0 : Td);
    Rg.setTranscriptMirrorBatcher(ro);
  }
  return { queryInstance: Rg, transport: kw, abortController: m, processEnv: dt };
}
function uw(e, t, r, o) {
  if (typeof r === "string") t.write(pe({ type: "user", session_id: "", message: { role: "user", content: [{ type: "text", text: r }] }, parent_tool_use_id: null }) + `
`);
  else e.streamInput(r).catch((n) => o.abort(n));
}
var Nne = /* @__PURE__ */ new Set(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"]);
async function kg(e) {
  for (let t = 0; ; t++) try {
    return await Ine(e, { recursive: true, force: true });
  } catch (r) {
    if (t >= 4 || !Nne.has(Ve(r) ?? "")) return;
    await un((t + 1) * 100);
  }
}
function jne(e, t) {
  e.waitForExit().catch(() => {
  }).finally(() => kg(t));
}
function DMe({ prompt: e, options: t }) {
  if ((t?.resume || t?.continue) && t?.sessionStore) {
    let { queryInstance: i, transport: s, abortController: a, processEnv: c } = lw({ ...t }, typeof e === "string", void 0, true), u = _u(t.cwd ?? "."), d = t.sessionStore, p = t.loadTimeoutMs ?? 6e4, f = t.resume;
    return (async () => {
      if (!f) f = (await Mr(d.listSessions(or(u)), p, `SessionStore.listSessions() timed out after ${p}ms`)).slice().sort((h, y) => y.mtime - h.mtime)[0]?.sessionId;
      if (!f) return;
      return vz(d, f, u, t.env, t.loadTimeoutMs);
    })().then((g) => {
      if (g) {
        s.updateResume(f);
        let h = { CLAUDE_CONFIG_DIR: g };
        if (process.platform === "win32") {
          let y = t.env?.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? t.env?.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? "";
          h.CLAUDE_SECURESTORAGE_CONFIG_DIR = y, c.CLAUDE_SECURESTORAGE_CONFIG_DIR = y;
        }
        s.updateEnv(h), c.CLAUDE_CONFIG_DIR = g, i.addCleanupCallback(() => jne(s, g));
      }
      if (!i.isClosed()) s.spawn();
    }).catch((g) => {
      let h = Pr(g);
      s.spawnAbort(h), i.setError(h);
    }), uw(i, s, e, a), i;
  }
  let { queryInstance: r, transport: o, abortController: n } = lw(t, typeof e === "string");
  return uw(r, o, e, n), r;
}
function Sz(e) {
  let t = _u(e ?? "."), r;
  try {
    r = Ene(t);
  } catch {
    r = t;
  }
  return Cr(r);
}
function or(e) {
  return wo(Sz(e));
}
function dw(e) {
  return typeof e === "object" && e !== null && "type" in e && e.type === "agent_metadata";
}
function gz(e, t) {
  let r = _z(t, e), o = r.split(fw);
  if (o[0] === ".." || bz(r)) return null;
  if (o.length < 2) return null;
  let n = o[0], i = o[1];
  if (o.length === 2 && i.endsWith(".jsonl")) return { projectKey: n, sessionId: i.replace(/\.jsonl$/, "") };
  if (o.length >= 4) {
    let s = o.slice(2), a = s.length - 1;
    return s[a] = s.at(-1).replace(/\.jsonl$/, ""), { projectKey: n, sessionId: i, subpath: s.join("/") };
  }
  return null;
}

// src/generator.ts
var MessageQueue = class {
  queue = [];
  resolveNext = null;
  closed = false;
  push(msg) {
    this.queue.push(msg);
    this.resolveNext?.();
    this.resolveNext = null;
  }
  close() {
    this.closed = true;
    this.resolveNext?.();
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift();
      } else if (this.closed) {
        return;
      } else {
        await new Promise((resolve) => {
          this.resolveNext = resolve;
        });
      }
    }
  }
};

// src/permissions.ts
var PermissionManager = class {
  pending = /* @__PURE__ */ new Map();
  makeCallback(emit2) {
    return async (toolName, input) => {
      const id2 = crypto.randomUUID();
      emit2({ type: "permission_request", id: id2, name: toolName, input });
      const approved = await new Promise((resolve) => {
        this.pending.set(id2, resolve);
      });
      return approved ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "\u7528\u6237\u62D2\u7EDD" };
    };
  }
  resolve(id2, approved) {
    const resolve = this.pending.get(id2);
    if (resolve) {
      this.pending.delete(id2);
      resolve(approved);
    }
  }
};

// src/mapper.ts
function buildUserMessage(prompt, images) {
  if (images.length === 0) {
    return { role: "user", content: prompt };
  }
  const blocks = images.map((img) => ({
    type: "image",
    source: {
      type: "base64",
      media_type: img.mediaType,
      data: img.data
    }
  }));
  if (prompt) {
    blocks.push({ type: "text", text: prompt });
  }
  return { role: "user", content: blocks };
}
function mapSdkMessage(msg, emit2) {
  if (msg.type === "system" && msg.subtype === "init") {
    emit2({ type: "session_init", session_id: msg.session_id });
    return;
  }
  if (msg.type === "assistant" && msg.message?.content) {
    for (const block of msg.message.content) {
      if (block.type === "text") {
        emit2({ type: "text_delta", delta: block.text });
      } else if (block.type === "tool_use") {
        emit2({ type: "tool_use_start", id: block.id, name: block.name, input: block.input });
      }
    }
    return;
  }
  if (msg.type === "user" && msg.message?.content) {
    for (const block of msg.message.content) {
      if (block.type === "tool_result") {
        const content = Array.isArray(block.content) ? block.content.map((c) => c.text ?? "").join("") : String(block.content ?? "");
        emit2({ type: "tool_result", id: block.tool_use_id, content, is_error: block.is_error ?? false });
      }
    }
    return;
  }
  if (msg.type === "result") {
    emit2({
      type: "message_stop",
      stop_reason: msg.subtype === "success" ? "end_turn" : msg.subtype,
      cost_usd: msg.total_cost_usd ?? null
    });
    return;
  }
}

// src/index.ts
function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\n");
}
var proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
if (proxyUrl) {
  const { ProxyAgent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}
var queue = new MessageQueue();
var permMgr = new PermissionManager();
var currentQuery = null;
var sessionId;
async function startLoop(cwd) {
  const originalCwd = process.cwd();
  if (cwd) process.chdir(cwd);
  try {
    while (true) {
      try {
        const q = DMe({
          prompt: queue[Symbol.asyncIterator](),
          options: {
            permissionMode: "default",
            canUseTool: permMgr.makeCallback(emit),
            settingSources: ["project", "user"],
            skills: "all",
            ...sessionId ? { resume: sessionId } : {}
          }
        });
        currentQuery = q;
        for await (const msg of q) {
          mapSdkMessage(msg, emit);
          if (msg.type === "system" && msg.subtype === "init") {
            sessionId = msg.session_id;
          }
        }
        break;
      } catch (e) {
        currentQuery = null;
        if (e?.name !== "AbortError") {
          emit({ type: "error", message: String(e?.message ?? e) });
        }
      }
    }
  } finally {
    currentQuery = null;
    if (cwd) process.chdir(originalCwd);
  }
}
var rl2 = readline.createInterface({ input: process.stdin });
var loopStarted = false;
rl2.on("line", (line) => {
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    return;
  }
  if (cmd.cmd === "send") {
    if (cmd.session_id) sessionId = cmd.session_id;
    if (!loopStarted) {
      loopStarted = true;
      startLoop(cmd.cwd);
    }
    queue.push({
      type: "user",
      message: buildUserMessage(cmd.prompt, cmd.images ?? []),
      parent_tool_use_id: null
    });
  } else if (cmd.cmd === "permission_response") {
    permMgr.resolve(cmd.id, cmd.approved);
  } else if (cmd.cmd === "interrupt") {
    currentQuery?.interrupt().catch(() => {
    });
  }
});
rl2.on("close", () => {
  queue.close();
  process.exit(0);
});
