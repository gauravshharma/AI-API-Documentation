/* ====================================================================
   API Docs Assistant — application logic (vanilla JS, zero deps)
   ==================================================================== */
(function () {
  "use strict";

  // ---------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------
  var CLAUDE_URL = "https://api.anthropic.com/v1/messages";
  var CLAUDE_MODEL = "claude-sonnet-4-20250514";
  var CLAUDE_MAX_TOKENS = 2000;
  var ANTHROPIC_VERSION = "2023-06-01";

  var LS = {
    apiKey: "apiassist.anthropic_key",
    confBase: "apiassist.conf_base",
    confSpace: "apiassist.conf_space",
    confEmail: "apiassist.conf_email",
    confToken: "apiassist.conf_token",
    onboarded: "apiassist.onboarded"
  };

  // ---------------------------------------------------------------
  // App state
  // ---------------------------------------------------------------
  var state = {
    rawSpec: null,       // original text
    specType: null,      // 'openapi3' | 'swagger2' | 'postman' | 'inferred'
    specObj: null,       // parsed object
    apiTitle: "API",
    baseUrl: "",
    endpoints: [],       // normalized endpoints
    coverage: null,      // { score, findings: [] }
    coverageFilter: "all",
    messages: [],        // chat history [{role, content}]
    generatedMarkdown: "",
    mode: "chat"
  };

  // ---------------------------------------------------------------
  // Tiny DOM helpers
  // ---------------------------------------------------------------
  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function show(node) { if (node) node.hidden = false; }
  function hide(node) { if (node) node.hidden = true; }
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // ---------------------------------------------------------------
  // Toasts (plain-English notifications)
  // ---------------------------------------------------------------
  function toast(kind, title, detail) {
    var host = $("#toast-host");
    var t = el("div", "toast " + kind);
    t.appendChild(el("div", "toast-title", title));
    if (detail) t.appendChild(el("div", "toast-fix", detail));
    host.appendChild(t);
    setTimeout(function () {
      t.style.transition = "opacity .3s";
      t.style.opacity = "0";
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
    }, kind === "error" ? 7000 : 4000);
  }

  // ---------------------------------------------------------------
  // Minimal YAML parser (handles common OpenAPI/Swagger YAML)
  // Supports: nested maps, block lists, scalars, quoted strings,
  // inline flow [..]/{..}, comments, and block scalars (|, >).
  // ---------------------------------------------------------------
  function parseYAML(text) {
    var rawLines = text.replace(/\r\n/g, "\n").replace(/\t/g, "  ").split("\n");
    // strip comments & blank lines, keep indentation; track block scalars
    var lines = [];
    for (var i = 0; i < rawLines.length; i++) {
      var line = rawLines[i];
      if (/^\s*#/.test(line) || /^\s*$/.test(line)) continue;
      // remove trailing comments (not inside quotes) — simple heuristic
      lines.push(line.replace(/\s+#.*$/, ""));
    }

    var idx = 0;
    function indentOf(s) { var m = s.match(/^(\s*)/); return m[1].length; }

    function parseScalar(v) {
      v = v.trim();
      if (v === "" ) return null;
      if (v === "null" || v === "~") return null;
      if (v === "true") return true;
      if (v === "false") return false;
      if (/^-?\d+$/.test(v)) return parseInt(v, 10);
      if (/^-?\d*\.\d+$/.test(v)) return parseFloat(v);
      if ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'")) {
        return v.slice(1, -1);
      }
      // inline flow collections
      if (v[0] === "[" || v[0] === "{") {
        try { return JSON.parse(jsonifyFlow(v)); } catch (e) { return v; }
      }
      return v;
    }

    function jsonifyFlow(v) {
      // convert simple YAML flow to JSON: quote bare keys/values
      return v.replace(/([{\[,]\s*)([A-Za-z_][\w-]*)(\s*:)/g, '$1"$2"$3')
              .replace(/:\s*([A-Za-z_][\w./-]*)\s*([,}\]])/g, ': "$1"$2');
    }

    function parseBlock(minIndent) {
      var container = null;
      while (idx < lines.length) {
        var line = lines[idx];
        var ind = indentOf(line);
        if (ind < minIndent) break;
        var content = line.slice(ind);

        if (content[0] === "-") {
          if (container === null) container = [];
          if (!Array.isArray(container)) break;
          idx++;
          var rest = content.slice(1).replace(/^\s/, "");
          if (rest === "") {
            container.push(parseBlock(ind + 1));
          } else if (/^[^:\n]+:(\s|$)/.test(rest) || /:\s*$/.test(rest)) {
            // list item that is itself a map; reinsert as a map line
            var injected = repeat(" ", ind + 2) + rest;
            lines.splice(idx, 0, injected);
            container.push(parseBlock(ind + 2));
          } else {
            container.push(parseScalar(rest));
          }
        } else {
          var ci = content.indexOf(":");
          if (ci === -1) { idx++; continue; }
          if (container === null) container = {};
          if (Array.isArray(container)) break;
          var key = content.slice(0, ci).trim().replace(/^['"]|['"]$/g, "");
          var val = content.slice(ci + 1).trim();
          idx++;
          if (val === "" ) {
            // could be nested block, or empty
            if (idx < lines.length && indentOf(lines[idx]) > ind) {
              container[key] = parseBlock(ind + 1);
            } else {
              container[key] = null;
            }
          } else if (val === "|" || val === ">" || val === "|-" || val === ">-") {
            var buf = [];
            while (idx < lines.length && (lines[idx].trim() === "" || indentOf(lines[idx]) > ind)) {
              buf.push(lines[idx].slice(ind + 2));
              idx++;
            }
            container[key] = val[0] === ">" ? buf.join(" ") : buf.join("\n");
          } else {
            container[key] = parseScalar(val);
          }
        }
      }
      return container === null ? {} : container;
    }

    function repeat(c, n) { var s = ""; for (var k = 0; k < n; k++) s += c; return s; }

    return parseBlock(0);
  }

  function repeat(c, n) { var s = ""; for (var k = 0; k < n; k++) s += c; return s; }

  // ---------------------------------------------------------------
  // Spec detection + parsing
  // ---------------------------------------------------------------
  function parseSpecText(text) {
    text = text.trim();
    if (!text) throw new Error("empty");
    var obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      try {
        obj = parseYAML(text);
      } catch (e2) {
        throw new Error("parse");
      }
    }
    if (!obj || typeof obj !== "object") throw new Error("parse");
    return obj;
  }

  function detectSpecType(obj) {
    if (obj.openapi && String(obj.openapi).indexOf("3") === 0) return "openapi3";
    if (obj.swagger && String(obj.swagger).indexOf("2") === 0) return "swagger2";
    if (obj.info && obj.item && (obj.info._postman_id || (obj.info.schema || "").indexOf("postman") !== -1)) return "postman";
    if (obj.item && Array.isArray(obj.item)) return "postman";
    if (obj.paths) return "openapi3"; // best effort
    return null;
  }

  // resolve $ref within a spec object
  function resolveRef(root, ref) {
    if (!ref || ref[0] !== "#") return null;
    var parts = ref.slice(2).split("/");
    var cur = root;
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].replace(/~1/g, "/").replace(/~0/g, "~");
      if (cur == null) return null;
      cur = cur[p];
    }
    return cur;
  }

  function deref(root, node, depth) {
    depth = depth || 0;
    if (depth > 6 || node == null || typeof node !== "object") return node;
    if (node.$ref) {
      var resolved = resolveRef(root, node.$ref);
      return deref(root, resolved, depth + 1);
    }
    return node;
  }

  // Build a realistic JSON example from a JSON schema
  function exampleFromSchema(root, schema, depth) {
    depth = depth || 0;
    schema = deref(root, schema, 0);
    if (!schema || depth > 6) return null;
    if (schema.example !== undefined) return schema.example;
    if (schema.default !== undefined) return schema.default;
    if (schema.enum && schema.enum.length) return schema.enum[0];
    var type = schema.type;
    if (!type && schema.properties) type = "object";
    switch (type) {
      case "object": {
        var o = {};
        var props = schema.properties || {};
        for (var k in props) { if (props.hasOwnProperty(k)) o[k] = exampleFromSchema(root, props[k], depth + 1); }
        return o;
      }
      case "array":
        return [exampleFromSchema(root, schema.items || {}, depth + 1)];
      case "integer": return 0;
      case "number": return 0;
      case "boolean": return true;
      case "string":
        if (schema.format === "date-time") return "2026-06-01T12:00:00Z";
        if (schema.format === "date") return "2026-06-01";
        if (schema.format === "email") return "user@example.com";
        return "";
      default:
        return null;
    }
  }

  // ---------------------------------------------------------------
  // Normalize any spec into state.endpoints
  // ---------------------------------------------------------------
  var METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

  function normalizeSpec(obj, type) {
    state.endpoints = [];
    if (type === "openapi3" || type === "swagger2") normalizeOpenAPI(obj, type);
    else if (type === "postman") normalizePostman(obj);
    else if (type === "inferred") { /* endpoints set directly */ }
  }

  function normalizeOpenAPI(obj, type) {
    state.apiTitle = (obj.info && obj.info.title) || "API";
    if (type === "openapi3") {
      var srv = (obj.servers && obj.servers[0] && obj.servers[0].url) || "";
      state.baseUrl = srv;
    } else {
      var scheme = (obj.schemes && obj.schemes[0]) || "https";
      state.baseUrl = (obj.host ? scheme + "://" + obj.host : "") + (obj.basePath || "");
    }
    var globalSecurity = obj.security || [];
    var paths = obj.paths || {};
    for (var p in paths) {
      if (!paths.hasOwnProperty(p)) continue;
      var pathItem = paths[p];
      var pathParams = pathItem.parameters || [];
      for (var mi = 0; mi < METHODS.length; mi++) {
        var m = METHODS[mi];
        var op = pathItem[m];
        if (!op) continue;
        var params = (op.parameters || []).concat(pathParams).map(function (pp) {
          return deref(obj, pp);
        });
        var ep = {
          method: m.toUpperCase(),
          path: p,
          summary: op.summary || "",
          description: op.description || "",
          operationId: op.operationId || "",
          tags: op.tags || [],
          parameters: params,
          requestBody: extractRequestBody(obj, op, type),
          responses: extractResponses(obj, op),
          security: op.security !== undefined ? op.security : globalSecurity,
          raw: op
        };
        state.endpoints.push(ep);
      }
    }
  }

  function extractRequestBody(root, op, type) {
    if (type === "openapi3") {
      if (!op.requestBody) return null;
      var rb = deref(root, op.requestBody);
      if (!rb || !rb.content) return rb ? { required: rb.required, schema: null } : null;
      var ct = rb.content["application/json"] || rb.content[Object.keys(rb.content)[0]];
      return { required: !!rb.required, schema: ct ? deref(root, ct.schema) : null };
    } else {
      // swagger2: body param
      var bodyParam = (op.parameters || []).filter(function (x) { return x.in === "body"; })[0];
      if (!bodyParam) return null;
      return { required: !!bodyParam.required, schema: deref(root, bodyParam.schema) };
    }
  }

  function extractResponses(root, op) {
    var out = [];
    var resp = op.responses || {};
    for (var code in resp) {
      if (!resp.hasOwnProperty(code)) continue;
      var r = deref(root, resp[code]);
      var schema = null;
      if (r) {
        if (r.content) {
          var ct = r.content["application/json"] || r.content[Object.keys(r.content)[0]];
          schema = ct ? deref(root, ct.schema) : null;
        } else if (r.schema) {
          schema = deref(root, r.schema);
        }
      }
      out.push({ code: code, description: (r && r.description) || "", schema: schema });
    }
    return out;
  }

  function normalizePostman(obj) {
    state.apiTitle = (obj.info && obj.info.name) || "API";
    state.baseUrl = "";
    function walk(items) {
      items.forEach(function (it) {
        if (it.item) { walk(it.item); return; }
        if (!it.request) return;
        var req = it.request;
        var method = (req.method || "GET").toUpperCase();
        var url = req.url;
        var pathStr = "";
        if (typeof url === "string") {
          pathStr = url.replace(/^https?:\/\/[^/]+/, "");
          if (!state.baseUrl) { var mm = url.match(/^https?:\/\/[^/]+/); if (mm) state.baseUrl = mm[0]; }
        } else if (url && url.path) {
          pathStr = "/" + url.path.join("/");
          if (!state.baseUrl && url.host) state.baseUrl = (url.protocol || "https") + "://" + url.host.join(".");
        }
        var body = null;
        if (req.body && req.body.raw) {
          var parsed = null;
          try { parsed = JSON.parse(req.body.raw); } catch (e) {}
          body = { required: true, schema: null, example: parsed != null ? parsed : req.body.raw };
        }
        var params = [];
        if (url && url.query) {
          url.query.forEach(function (q) {
            params.push({ name: q.key, in: "query", description: q.description || "", required: false, schema: { type: "string" } });
          });
        }
        var pathVars = (pathStr.match(/:([A-Za-z0-9_]+)/g) || []).map(function (v) { return v.slice(1); });
        pathVars.forEach(function (v) {
          params.push({ name: v, in: "path", description: "", required: true, schema: { type: "string" } });
        });
        pathStr = pathStr.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
        state.endpoints.push({
          method: method,
          path: pathStr || "/",
          summary: it.name || "",
          description: (req.description) || "",
          operationId: "",
          tags: [],
          parameters: params,
          requestBody: body,
          responses: [{ code: "200", description: "Successful response", schema: null }],
          security: req.auth ? [{ type: req.auth.type }] : [],
          raw: it
        });
      });
    }
    walk(obj.item || []);
  }

  // ---------------------------------------------------------------
  // Coverage report (Feature 3)
  // ---------------------------------------------------------------
  function runCoverage() {
    var findings = [];
    var eps = state.endpoints;
    var anyAuth = eps.some(function (e) { return e.security && e.security.length; });
    var anyExample = JSON.stringify(state.specObj || {}).indexOf('"example"') !== -1 ||
                     JSON.stringify(state.specObj || {}).indexOf('"examples"') !== -1;

    eps.forEach(function (ep) {
      var label = ep.method + " " + ep.path;
      if (!ep.summary && !ep.description) {
        findings.push(mkFinding(ep, "Medium", "No description or summary", "Add a short sentence explaining what this endpoint does."));
      }
      if (["POST", "PUT", "PATCH"].indexOf(ep.method) !== -1) {
        if (!ep.requestBody || !ep.requestBody.schema) {
          findings.push(mkFinding(ep, "High", "Missing request body schema", "Describe the JSON fields this endpoint accepts."));
        }
      }
      var has2xx = ep.responses.some(function (r) { return /^2\d\d$/.test(r.code); });
      var has2xxSchema = ep.responses.some(function (r) { return /^2\d\d$/.test(r.code) && r.schema; });
      if (has2xx && !has2xxSchema && ep.method !== "DELETE") {
        findings.push(mkFinding(ep, "High", "Missing response schema for success (2xx)", "Show what a successful response looks like."));
      }
      ep.parameters.forEach(function (pm) {
        if (pm && !pm.description) {
          findings.push(mkFinding(ep, "Low", "Parameter '" + (pm.name || "?") + "' has no description", "Explain what this parameter is for."));
        }
      });
      if (anyAuth && (!ep.security || !ep.security.length)) {
        findings.push(mkFinding(ep, "High", "No authentication defined while other endpoints require it", "Confirm whether this endpoint should be protected."));
      }
    });

    if (!anyExample && eps.length) {
      findings.push({ ep: null, label: "(whole spec)", severity: "Medium", issue: "No request/response examples anywhere in the spec", fix: "Add realistic example values so developers can copy-paste." });
    }

    // Score: weighted penalties, capped per endpoint
    var weights = { High: 12, Medium: 6, Low: 2 };
    var maxPenalty = Math.max(1, eps.length) * 24;
    var penalty = 0;
    findings.forEach(function (f) { penalty += weights[f.severity] || 4; });
    var score = Math.round(Math.max(0, 100 - (penalty / maxPenalty) * 100));
    if (!findings.length) score = 100;

    state.coverage = { score: score, findings: findings };
    renderCoverage();
  }

  function mkFinding(ep, severity, issue, fix) {
    return { ep: ep, label: ep.method + " " + ep.path, severity: severity, issue: issue, fix: fix };
  }

  function renderCoverage() {
    var c = state.coverage;
    if (!c) return;
    show($("#coverage-summary-section"));
    var ringPct = c.score + "%";
    $("#coverage-ring").style.setProperty("--score", ringPct);
    $("#coverage-ring-lg").style.setProperty("--score", ringPct);
    $("#coverage-score").textContent = c.score;
    $("#coverage-score-lg").textContent = c.score;

    var counts = { High: 0, Medium: 0, Low: 0 };
    c.findings.forEach(function (f) { counts[f.severity]++; });
    $("#coverage-summary-text").innerHTML = c.findings.length
      ? "Found <strong>" + c.findings.length + "</strong> documentation gap" + (c.findings.length === 1 ? "" : "s") +
        " — " + counts.High + " high, " + counts.Medium + " medium, " + counts.Low + " low. Fix the high-severity ones first."
      : "Great news — no documentation gaps detected. Your spec scores a perfect 100.";

    renderFindingsList();
  }

  function renderFindingsList() {
    var c = state.coverage;
    var host = $("#coverage-findings");
    host.innerHTML = "";
    if (!c.findings.length) {
      var ok = el("div", "coverage-perfect", "✓ No gaps found. This API is fully documented.");
      host.appendChild(ok);
      return;
    }
    var filtered = c.findings.filter(function (f) {
      return state.coverageFilter === "all" || f.severity === state.coverageFilter;
    });
    if (!filtered.length) {
      host.appendChild(el("p", "muted", "No " + state.coverageFilter + "-severity findings."));
      return;
    }
    filtered.forEach(function (f, i) {
      var card = el("div", "finding " + f.severity);
      var head = el("div", "finding-head");
      head.appendChild(el("span", "sev-tag " + f.severity, f.severity));
      head.appendChild(el("strong", null, f.label));
      head.appendChild(el("span", "muted small", "· " + f.issue));
      card.appendChild(head);
      card.appendChild(el("p", "finding-issue", "Suggested fix: " + f.fix));
      if (f.ep) {
        var actions = el("div", "finding-actions");
        var btn = el("button", "btn btn-ghost btn-sm", "✨ Fix with AI");
        btn.title = "Ask the AI to generate the missing documentation for this endpoint";
        btn.addEventListener("click", function () { fixWithAI(f); });
        actions.appendChild(btn);
        card.appendChild(actions);
      }
      host.appendChild(card);
    });
  }

  function fixWithAI(finding) {
    var ep = finding.ep;
    closeModal($("#coverage-modal"));
    switchMode("chat");
    var prompt = "The endpoint " + finding.label + " has this documentation gap: \"" + finding.issue +
      "\". Please generate the missing documentation for this endpoint only. Provide it as clean Markdown " +
      "(method, URL, description, parameters/request body as needed, a realistic success response example, and a short note). " +
      "Use realistic example values, never placeholders like 'string'.";
    sendChat(prompt, "Fix " + finding.label);
  }

  // ---------------------------------------------------------------
  // Claude API
  // ---------------------------------------------------------------
  function getApiKey() { return localStorage.getItem(LS.apiKey) || ""; }

  function callClaude(system, messages) {
    var headers = {
      "Content-Type": "application/json",
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-dangerous-direct-browser-access": "true"
    };
    var key = getApiKey();
    if (key) headers["x-api-key"] = key;

    var body = {
      model: CLAUDE_MODEL,
      max_tokens: CLAUDE_MAX_TOKENS,
      system: system,
      messages: messages
    };

    return fetch(CLAUDE_URL, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(body)
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (txt) {
          var friendly = friendlyApiError(res.status, txt);
          var err = new Error(friendly.message);
          err.friendly = friendly;
          throw err;
        });
      }
      return res.json();
    }).then(function (data) {
      if (data && data.content && data.content.length) {
        return data.content.map(function (b) { return b.text || ""; }).join("");
      }
      throw new Error("The AI returned an empty response. Please try again.");
    });
  }

  function friendlyApiError(status, raw) {
    if (status === 401 || status === 403) {
      return { title: "The AI rejected the request", message: "Your Claude API key is missing or not valid.", fix: "Open Settings and paste a valid Anthropic API key, then try again." };
    }
    if (status === 429) {
      return { title: "Too many requests", message: "Claude is rate-limiting your requests.", fix: "Wait a few seconds and try again." };
    }
    if (status === 400) {
      return { title: "The request couldn't be processed", message: "Claude couldn't read this request.", fix: "Your spec may be very large — try a smaller spec or generate docs for fewer endpoints." };
    }
    if (status === 0 || status >= 500) {
      return { title: "Couldn't reach the AI service", message: "The connection to Claude failed.", fix: "Check your internet connection, or whether your environment allows calls to api.anthropic.com, then retry." };
    }
    return { title: "Something went wrong talking to the AI", message: "Unexpected response (status " + status + ").", fix: "Please try again in a moment." };
  }

  function ensureKeyOrWarn() {
    // We don't hard-block: the environment may proxy auth. Just inform once.
    return true;
  }

  // ---------------------------------------------------------------
  // System prompts
  // ---------------------------------------------------------------
  function docsSystemPrompt() {
    return "You are a Senior API Solutions Architect. Convert this spec into production-ready developer " +
      "documentation using this exact structure: API Overview (purpose, use cases, auth, base URL) -> one " +
      "section per endpoint with: Method, URL, Description, Request (headers table, path params table, query " +
      "params table, request body JSON example), Response (success status + JSON example, error table), Example " +
      "Usage (cURL, JavaScript fetch, Axios, Python requests), Developer Notes (validation rules, edge cases, " +
      "performance), Testing (positive and negative test cases). Use Markdown. Infer realistic examples - never " +
      "use placeholder strings like 'string' or 'example'.";
  }

  function chatSystemPrompt() {
    var specSummary = buildSpecContext();
    return "You are an API documentation assistant for the \"" + state.apiTitle + "\" API. " +
      "Follow these rules strictly:\n" +
      "1. Answer ONLY from the provided specification below. Never invent endpoints, parameters, fields, or behavior.\n" +
      "2. Always cite the endpoint name (e.g. GET /tasks, POST /auth/token) when referring to it.\n" +
      "3. Provide working code examples (cURL, JavaScript fetch, Python requests) when asked or when helpful.\n" +
      "4. If the requested information is not in the specification, respond with EXACTLY this sentence and nothing else: " +
      "\"That information is not available in the provided documentation.\"\n" +
      "5. Suggest related endpoints when relevant.\n" +
      "6. Be concise and use Markdown formatting (headings, tables, fenced code blocks with language labels).\n\n" +
      "=== API SPECIFICATION ===\n" + specSummary;
  }

  function buildSpecContext() {
    // Compact, structured context to keep token use reasonable.
    var lines = [];
    lines.push("API title: " + state.apiTitle);
    if (state.baseUrl) lines.push("Base URL: " + state.baseUrl);
    lines.push("");
    state.endpoints.forEach(function (ep) {
      lines.push("### " + ep.method + " " + ep.path);
      if (ep.summary) lines.push("Summary: " + ep.summary);
      if (ep.description) lines.push("Description: " + ep.description);
      if (ep.security && ep.security.length) lines.push("Auth: required");
      if (ep.parameters && ep.parameters.length) {
        lines.push("Parameters:");
        ep.parameters.forEach(function (pm) {
          if (!pm) return;
          lines.push("  - " + pm.name + " (" + (pm.in || "?") + (pm.required ? ", required" : "") + "): " + (pm.description || ""));
        });
      }
      if (ep.requestBody && ep.requestBody.schema) {
        var ex = exampleFromSchema(state.specObj, ep.requestBody.schema);
        lines.push("Request body example: " + safeJson(ex));
      } else if (ep.requestBody && ep.requestBody.example !== undefined) {
        lines.push("Request body example: " + safeJson(ep.requestBody.example));
      }
      ep.responses.forEach(function (r) {
        var s = "Response " + r.code + ": " + (r.description || "");
        if (r.schema) {
          var rex = exampleFromSchema(state.specObj, r.schema);
          s += " | example: " + safeJson(rex);
        }
        lines.push(s);
      });
      lines.push("");
    });
    var ctx = lines.join("\n");
    // Hard cap to avoid oversized requests
    if (ctx.length > 18000) ctx = ctx.slice(0, 18000) + "\n…(specification truncated)…";
    return ctx;
  }

  function safeJson(v) {
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }

  // ---------------------------------------------------------------
  // Markdown renderer (compact)
  // ---------------------------------------------------------------
  function renderMarkdown(md) {
    md = String(md || "");
    var out = [];
    var lines = md.replace(/\r\n/g, "\n").split("\n");
    var i = 0;

    function inline(t) {
      // escape, then apply inline rules
      t = escapeHtml(t);
      // inline code
      t = t.replace(/`([^`]+)`/g, function (_, c) { return "<code>" + c + "</code>"; });
      // bold
      t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      t = t.replace(/__([^_]+)__/g, "<strong>$1</strong>");
      // italics
      t = t.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
      // links
      t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (_, txt, url) {
        return '<a href="' + url + '" target="_blank" rel="noopener">' + txt + "</a>";
      });
      return t;
    }

    while (i < lines.length) {
      var line = lines[i];

      // fenced code block
      var fence = line.match(/^```\s*([A-Za-z0-9+#._-]*)\s*$/);
      if (fence) {
        var lang = fence[1] || "";
        var buf = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // skip closing fence
        var langLabel = lang ? '<span class="code-lang">' + escapeHtml(lang) + "</span>" : "";
        out.push("<pre>" + langLabel + "<code>" + escapeHtml(buf.join("\n")) + "</code></pre>");
        continue;
      }

      // table
      if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1].replace(/[^|:\-\s]/g, ""))) {
        var headerCells = splitRow(line);
        i += 2; // skip header + separator
        var rows = [];
        while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim() !== "") {
          rows.push(splitRow(lines[i]));
          i++;
        }
        var th = headerCells.map(function (c) { return "<th>" + inline(c) + "</th>"; }).join("");
        var trs = rows.map(function (r) {
          return "<tr>" + r.map(function (c) { return "<td>" + inline(c) + "</td>"; }).join("") + "</tr>";
        }).join("");
        out.push("<table><thead><tr>" + th + "</tr></thead><tbody>" + trs + "</tbody></table>");
        continue;
      }

      // headings
      var h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        var lvl = h[1].length;
        out.push("<h" + lvl + ">" + inline(h[2]) + "</h" + lvl + ">");
        i++;
        continue;
      }

      // hr
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push("<hr>"); i++; continue; }

      // blockquote
      if (/^\s*>\s?/.test(line)) {
        var qb = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { qb.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
        out.push("<blockquote>" + inline(qb.join(" ")) + "</blockquote>");
        continue;
      }

      // unordered list
      if (/^\s*[-*+]\s+/.test(line)) {
        var items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          items.push("<li>" + inline(lines[i].replace(/^\s*[-*+]\s+/, "")) + "</li>");
          i++;
        }
        out.push("<ul>" + items.join("") + "</ul>");
        continue;
      }

      // ordered list
      if (/^\s*\d+\.\s+/.test(line)) {
        var oItems = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          oItems.push("<li>" + inline(lines[i].replace(/^\s*\d+\.\s+/, "")) + "</li>");
          i++;
        }
        out.push("<ol>" + oItems.join("") + "</ol>");
        continue;
      }

      // blank
      if (line.trim() === "") { i++; continue; }

      // paragraph (gather consecutive non-special lines)
      var pbuf = [line];
      i++;
      while (i < lines.length && lines[i].trim() !== "" &&
             !/^```/.test(lines[i]) && !/^(#{1,6})\s/.test(lines[i]) &&
             !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i]) &&
             !/^\s*>\s?/.test(lines[i]) && !/\|/.test(lines[i])) {
        pbuf.push(lines[i]); i++;
      }
      out.push("<p>" + inline(pbuf.join(" ")) + "</p>");
    }
    return out.join("\n");
  }

  function splitRow(line) {
    var t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    return t.split("|").map(function (c) { return c.trim(); });
  }

  // ---------------------------------------------------------------
  // Spec loading orchestration
  // ---------------------------------------------------------------
  function loadSpecFromObject(obj, type, sourceLabel) {
    type = type || detectSpecType(obj);
    if (!type) {
      toast("error", "Unrecognized format", "This doesn't look like OpenAPI, Swagger, or a Postman collection. Double-check the file.");
      return false;
    }
    state.specObj = obj;
    state.specType = type;
    state.rawSpec = safeJson(obj);
    normalizeSpec(obj, type);
    if (!state.endpoints.length) {
      toast("error", "No endpoints found", "We loaded the file but couldn't find any endpoints in it. Make sure it's a complete spec.");
      return false;
    }
    onSpecLoaded(sourceLabel);
    return true;
  }

  function onSpecLoaded(sourceLabel) {
    // status
    var st = $("#spec-status");
    st.className = "spec-status loaded";
    $("#spec-status-text").textContent = state.apiTitle + " — " + state.endpoints.length + " endpoints";
    $("#open-loader-btn").textContent = "Replace spec";

    renderEndpointList();
    runCoverage();

    // reset chat
    state.messages = [];
    state.generatedMarkdown = "";
    $("#docs-markdown").value = "";
    $("#docs-preview").innerHTML = "";
    setDocsButtonsEnabled(false);

    // reveal chat composer + empty docs ready
    $("#chat-log").innerHTML = "";
    hide($("#chat-empty"));
    show($("#chat-log"));
    show($("#chat-composer"));
    hide($("#docs-empty"));
    show($("#docs-workspace"));

    pushAssistantWelcome();

    toast("success", "Spec loaded", "Loaded " + state.endpoints.length + " endpoints from " + (sourceLabel || "your spec") + ". Ask a question or generate docs.");
    closeModal($("#loader-modal"));
  }

  function pushAssistantWelcome() {
    var msg = "**" + state.apiTitle + "** is loaded with **" + state.endpoints.length + " endpoints**. " +
      "Ask me anything — for example *\"How do I authenticate?\"* or click an endpoint in the sidebar. " +
      "I'll answer only from your specification.";
    renderMessage("assistant", msg, false);
  }

  function renderEndpointList() {
    var host = $("#endpoint-list");
    host.innerHTML = "";
    $("#endpoint-count").textContent = state.endpoints.length;
    if (!state.endpoints.length) {
      host.appendChild(el("p", "muted small", "No endpoints."));
      return;
    }
    state.endpoints.forEach(function (ep) {
      var item = el("button", "endpoint-item");
      item.title = "Ask the assistant about " + ep.method + " " + ep.path;
      var badge = el("span", "method-badge m-" + ep.method.toLowerCase(), ep.method);
      var path = el("span", "endpoint-path", ep.path);
      item.appendChild(badge);
      item.appendChild(path);
      item.addEventListener("click", function () {
        switchMode("chat");
        closeSidebarMobile();
        sendChat("Tell me about the " + ep.method + " " + ep.path + " endpoint — what it does, its parameters, and a code example.", ep.method + " " + ep.path);
      });
      host.appendChild(item);
    });
  }

  // ---------------------------------------------------------------
  // URL + GitHub loading
  // ---------------------------------------------------------------
  function setLoaderStatus(kind, text) {
    var s = $("#loader-status");
    s.className = "loader-status " + kind;
    s.innerHTML = "";
    if (kind === "info") s.appendChild(el("span", "spinner"));
    s.appendChild(el("span", null, text));
    show(s);
  }

  function fetchFromUrl(url) {
    if (!/^https?:\/\//.test(url)) {
      toast("error", "That doesn't look like a link", "Enter a full URL starting with https://");
      return;
    }
    setLoaderStatus("info", "Reading your API spec…");
    fetch(url).then(function (r) {
      if (!r.ok) throw new Error("http " + r.status);
      return r.text();
    }).then(function (text) {
      var obj = parseSpecText(text);
      var ok = loadSpecFromObject(obj, null, url);
      if (ok) hide($("#loader-status"));
    }).catch(function (e) {
      var msg = /Failed to fetch|NetworkError|TypeError/.test(String(e))
        ? "Couldn't download that file. The server may block cross-origin requests (CORS), or the link is wrong."
        : (e.message === "parse" ? "Downloaded the file, but it isn't valid JSON or YAML." : "Couldn't load the spec from that URL.");
      setLoaderStatus("error", msg + " Try downloading it and pasting the contents instead.");
    });
  }

  function parseGitHubUrl(url) {
    var m = url.match(/github\.com\/([^/]+)\/([^/#?]+)/);
    if (!m) return null;
    return { owner: m[1], repo: m[2].replace(/\.git$/, "") };
  }

  var SPEC_FILE_RE = /(openapi|swagger)\.(json|ya?ml)$|(^|\/)api[-_.]?docs?\.(json|ya?ml)$/i;
  var ROUTE_HINT_RE = /(routes?\/|controllers?\/|app\.js$|server\.js$|index\.js$|main\.py$|app\.py$|urls\.py$|routes\.py$|\.controller\.(t|j)s$|router\.(t|j)s$)/i;

  function ghApi(owner, repo, path) {
    return "https://api.github.com/repos/" + owner + "/" + repo + "/contents/" + (path || "");
  }

  function scanGitHub(url) {
    var parsed = parseGitHubUrl(url);
    if (!parsed) {
      toast("error", "That's not a GitHub repo link", "Use a link like https://github.com/owner/repo");
      return;
    }
    setLoaderStatus("info", "Scanning the repository for an API spec…");
    var results = $("#github-results");
    results.innerHTML = "";
    hide(results);

    // recursively list files (limited depth)
    var found = [];      // spec file candidates
    var routeFiles = []; // route/source candidates
    var pending = 0;
    var maxFiles = 400;
    var visited = 0;

    function walk(path, depth) {
      if (depth > 3 || visited > maxFiles) return;
      pending++;
      fetch(ghApi(parsed.owner, parsed.repo, path), { headers: { "Accept": "application/vnd.github+json" } })
        .then(function (r) {
          if (!r.ok) throw new Error("http " + r.status);
          return r.json();
        })
        .then(function (items) {
          if (!Array.isArray(items)) items = [items];
          items.forEach(function (it) {
            visited++;
            if (it.type === "dir") {
              if (depth < 3 && !/node_modules|\.git|dist|build|vendor/.test(it.path)) walk(it.path, depth + 1);
            } else if (it.type === "file") {
              if (SPEC_FILE_RE.test(it.name)) found.push(it);
              else if (ROUTE_HINT_RE.test(it.path)) routeFiles.push(it);
            }
          });
        })
        .catch(function (e) {
          if (depth === 0) setLoaderStatus("error", githubError(e) );
        })
        .then(function () {
          pending--;
          if (pending === 0) finishScan(parsed, found, routeFiles);
        });
    }
    walk("", 0);
  }

  function githubError(e) {
    if (/403/.test(String(e.message))) return "GitHub is rate-limiting anonymous requests. Wait a minute and try again, or paste the spec directly.";
    if (/404/.test(String(e.message))) return "Couldn't find that repository. Check the URL and that the repo is public.";
    return "Couldn't read that repository. Make sure the URL is correct and the repo is public.";
  }

  function finishScan(parsed, found, routeFiles) {
    var results = $("#github-results");
    results.innerHTML = "";
    show(results);

    if (found.length) {
      setLoaderStatus("info", "Found a spec file — loading it…");
      results.appendChild(el("p", "muted small", "Found " + found.length + " spec file(s). Loading the first automatically; pick another if needed:"));
      found.forEach(function (f, i) {
        var row = el("div", "gh-file");
        row.appendChild(el("span", null, f.path));
        var b = el("button", "btn btn-ghost btn-sm", "Load");
        b.title = "Load " + f.path;
        b.addEventListener("click", function () { loadGitHubFile(f); });
        row.appendChild(b);
        results.appendChild(row);
      });
      loadGitHubFile(found[0]);
      return;
    }

    if (routeFiles.length) {
      setLoaderStatus("info", "No spec file found — reading route files so the AI can infer endpoints…");
      results.appendChild(el("p", "muted small", "No OpenAPI/Swagger file found. Found " + routeFiles.length + " route/source file(s). The AI will infer the API from them."));
      inferFromSource(parsed, routeFiles.slice(0, 8));
      return;
    }

    setLoaderStatus("error", "We couldn't find a spec file or recognizable route files in this repo. Try pasting the spec directly, or point to a repo with an openapi.json/swagger.yaml.");
  }

  function loadGitHubFile(file) {
    setLoaderStatus("info", "Reading " + file.name + "…");
    var url = file.download_url;
    fetch(url).then(function (r) { return r.text(); })
      .then(function (text) {
        var obj = parseSpecText(text);
        var ok = loadSpecFromObject(obj, null, file.path);
        if (ok) hide($("#loader-status"));
      })
      .catch(function (e) {
        setLoaderStatus("error", "Found the file but couldn't parse it as a valid spec. It may be incomplete.");
      });
  }

  function inferFromSource(parsed, files) {
    var fetches = files.map(function (f) {
      return fetch(f.download_url).then(function (r) { return r.text(); })
        .then(function (t) { return { path: f.path, content: t.slice(0, 6000) }; })
        .catch(function () { return null; });
    });
    Promise.all(fetches).then(function (all) {
      var snippets = all.filter(Boolean);
      if (!snippets.length) {
        setLoaderStatus("error", "Couldn't read the route files. Try pasting your spec directly.");
        return;
      }
      setLoaderStatus("info", "Asking the AI to infer your API endpoints from the source code…");
      var combined = snippets.map(function (s) { return "// FILE: " + s.path + "\n" + s.content; }).join("\n\n");
      var sys = "You are a Senior API Solutions Architect. From the route/controller source code provided, infer the " +
        "API endpoints and produce a valid OpenAPI 3.0 JSON specification. Output ONLY raw JSON (no markdown fences, " +
        "no commentary). Infer realistic paths, methods, parameters, request bodies, and 2xx responses with realistic " +
        "example values. Never use placeholder strings like 'string'.";
      var msgs = [{ role: "user", content: "Infer an OpenAPI 3.0 spec from this source code:\n\n" + combined }];
      callClaude(sys, msgs).then(function (text) {
        var json = extractJson(text);
        var obj = JSON.parse(json);
        state.specType = "openapi3";
        var ok = loadSpecFromObject(obj, "openapi3", "inferred from " + parsed.repo + " source");
        if (ok) {
          hide($("#loader-status"));
          toast("info", "Endpoints inferred by AI", "These were guessed from source code and may be incomplete — review them.");
        }
      }).catch(function (e) {
        var f = e.friendly;
        setLoaderStatus("error", (f ? f.message + " " + f.fix : "The AI couldn't infer endpoints from this code.") + " You can also paste your spec directly.");
      });
    });
  }

  function extractJson(text) {
    text = text.trim();
    text = text.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
    var start = text.indexOf("{");
    var end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1) return text.slice(start, end + 1);
    return text;
  }

  // ---------------------------------------------------------------
  // Chat (Feature 2)
  // ---------------------------------------------------------------
  function renderMessage(role, content, isMarkdown) {
    var log = $("#chat-log");
    var msg = el("div", "msg msg-" + (role === "user" ? "user" : "ai"));
    var avatar = el("div", "msg-avatar", role === "user" ? "🧑" : "🤖");
    var bubble = el("div", "msg-bubble markdown-body");
    if (isMarkdown === false) {
      bubble.innerHTML = renderMarkdown(content);
    } else {
      bubble.innerHTML = renderMarkdown(content);
    }
    msg.appendChild(avatar);
    msg.appendChild(bubble);
    log.appendChild(msg);
    log.scrollTop = log.scrollHeight;
    return bubble;
  }

  function showTyping() {
    var log = $("#chat-log");
    var msg = el("div", "msg msg-ai");
    msg.id = "typing-msg";
    msg.appendChild(el("div", "msg-avatar", "🤖"));
    var bubble = el("div", "msg-bubble");
    var typing = el("div", "typing");
    typing.appendChild(el("span"));
    typing.appendChild(el("span"));
    typing.appendChild(el("span"));
    bubble.appendChild(typing);
    msg.appendChild(bubble);
    log.appendChild(msg);
    log.scrollTop = log.scrollHeight;
  }
  function removeTyping() {
    var t = $("#typing-msg");
    if (t && t.parentNode) t.parentNode.removeChild(t);
  }

  function sendChat(text, displayText) {
    if (!state.endpoints.length) {
      toast("error", "No spec loaded yet", "Load an API spec first, then I can answer questions about it.");
      return;
    }
    text = (text || "").trim();
    if (!text) return;
    renderMessage("user", displayText || text);
    state.messages.push({ role: "user", content: text });
    showTyping();

    callClaude(chatSystemPrompt(), state.messages).then(function (answer) {
      removeTyping();
      renderMessage("assistant", answer);
      state.messages.push({ role: "assistant", content: answer });
    }).catch(function (e) {
      removeTyping();
      var f = e.friendly;
      var reply = f ? ("**" + f.title + "**\n\n" + f.message + "\n\n*Suggested fix: " + f.fix + "*")
                    : ("**Something went wrong**\n\n" + e.message);
      renderMessage("assistant", reply);
      if (f) toast("error", f.title, f.fix);
    });
  }

  // ---------------------------------------------------------------
  // Docs generator (Feature 1)
  // ---------------------------------------------------------------
  function generateDocs() {
    if (!state.endpoints.length) {
      toast("error", "No spec loaded yet", "Load an API spec first, then generate docs.");
      return;
    }
    var btn = $("#generate-docs-btn");
    btn.disabled = true;
    var original = btn.textContent;
    btn.textContent = "Generating documentation…";
    $("#docs-preview").innerHTML = '<p class="muted">⏳ Generating documentation… this can take a moment for large specs.</p>';

    var specForClaude = state.rawSpec;
    if (specForClaude.length > 16000) {
      specForClaude = buildSpecContext(); // fall back to compact context
    }
    var msgs = [{ role: "user", content: "Here is the API specification:\n\n" + specForClaude }];

    callClaude(docsSystemPrompt(), msgs).then(function (md) {
      md = md.replace(/^```(markdown)?\s*/i, "").replace(/\s*```$/i, "");
      state.generatedMarkdown = md;
      $("#docs-markdown").value = md;
      $("#docs-preview").innerHTML = renderMarkdown(md);
      setDocsButtonsEnabled(true);
      toast("success", "Documentation ready", "Review it, edit if needed, then copy, download, or export to Confluence.");
    }).catch(function (e) {
      var f = e.friendly;
      $("#docs-preview").innerHTML = '<p class="muted">' + escapeHtml(f ? f.message + " " + f.fix : e.message) + "</p>";
      if (f) toast("error", f.title, f.fix);
      else toast("error", "Couldn't generate docs", e.message);
    }).then(function () {
      btn.disabled = false;
      btn.textContent = original;
    });
  }

  function setDocsButtonsEnabled(on) {
    $("#copy-docs-btn").disabled = !on;
    $("#download-docs-btn").disabled = !on;
    $("#export-confluence-btn").disabled = !on;
  }

  // ---------------------------------------------------------------
  // Confluence export (Feature 4)
  // ---------------------------------------------------------------
  function markdownToConfluence(md) {
    // Convert a subset of Markdown to Confluence Storage Format (XHTML).
    var lines = md.replace(/\r\n/g, "\n").split("\n");
    var out = [];
    var i = 0;
    function inlineConf(t) {
      t = escapeHtml(t);
      t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
      t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
      return t;
    }
    while (i < lines.length) {
      var line = lines[i];
      var fence = line.match(/^```\s*([A-Za-z0-9+#._-]*)\s*$/);
      if (fence) {
        var lang = fence[1] || "none";
        var buf = []; i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        out.push('<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">' + escapeHtml(lang) +
          '</ac:parameter><ac:plain-text-body><![CDATA[' + buf.join("\n") + "]]></ac:plain-text-body></ac:structured-macro>");
        continue;
      }
      if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1].replace(/[^|:\-\s]/g, ""))) {
        var header = splitRow(line); i += 2;
        var rows = [];
        while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim() !== "") { rows.push(splitRow(lines[i])); i++; }
        var thead = "<tr>" + header.map(function (c) { return "<th>" + inlineConf(c) + "</th>"; }).join("") + "</tr>";
        var tbody = rows.map(function (r) { return "<tr>" + r.map(function (c) { return "<td>" + inlineConf(c) + "</td>"; }).join("") + "</tr>"; }).join("");
        out.push("<table><tbody>" + thead + tbody + "</tbody></table>");
        continue;
      }
      var h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { out.push("<h" + h[1].length + ">" + inlineConf(h[2]) + "</h" + h[1].length + ">"); i++; continue; }
      if (/^\s*(-{3,})\s*$/.test(line)) { out.push("<hr/>"); i++; continue; }
      if (/^\s*[-*+]\s+/.test(line)) {
        var items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { items.push("<li>" + inlineConf(lines[i].replace(/^\s*[-*+]\s+/, "")) + "</li>"); i++; }
        out.push("<ul>" + items.join("") + "</ul>"); continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        var oItems = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { oItems.push("<li>" + inlineConf(lines[i].replace(/^\s*\d+\.\s+/, "")) + "</li>"); i++; }
        out.push("<ol>" + oItems.join("") + "</ol>"); continue;
      }
      if (line.trim() === "") { i++; continue; }
      var pbuf = [line]; i++;
      while (i < lines.length && lines[i].trim() !== "" && !/^```/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) &&
             !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i]) && !/\|/.test(lines[i])) { pbuf.push(lines[i]); i++; }
      out.push("<p>" + inlineConf(pbuf.join(" ")) + "</p>");
    }
    return out.join("\n");
  }

  function publishToConfluence() {
    var base = (localStorage.getItem(LS.confBase) || "").replace(/\/$/, "");
    var space = localStorage.getItem(LS.confSpace) || "";
    var email = localStorage.getItem(LS.confEmail) || "";
    var token = localStorage.getItem(LS.confToken) || "";
    var title = $("#conf-page-title").value.trim() || (state.apiTitle + " — API Documentation");
    var statusEl = $("#confluence-status");

    if (!base || !space || !email || !token) {
      statusEl.className = "loader-status error";
      statusEl.textContent = "Missing Confluence settings. Add Base URL, Space key, email, and token in Settings — or use \"Copy Confluence markup\" and paste it manually.";
      show(statusEl);
      return;
    }
    var storage = markdownToConfluence(state.generatedMarkdown || $("#docs-markdown").value);
    statusEl.className = "loader-status info";
    statusEl.innerHTML = "";
    statusEl.appendChild(el("span", "spinner"));
    statusEl.appendChild(el("span", null, "Connecting to Confluence…"));
    show(statusEl);

    var payload = {
      type: "page",
      title: title,
      space: { key: space },
      body: { storage: { value: storage, representation: "storage" } }
    };
    fetch(base + "/wiki/rest/api/content", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Basic " + btoa(email + ":" + token)
      },
      body: JSON.stringify(payload)
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(r.status + ":" + t); });
      return r.json();
    }).then(function (data) {
      var link = base + "/wiki" + ((data._links && data._links.webui) || "");
      statusEl.className = "loader-status success";
      statusEl.innerHTML = "✓ Page created. <a href=\"" + escapeHtml(link) + "\" target=\"_blank\" rel=\"noopener\">Open it in Confluence →</a>";
      toast("success", "Published to Confluence", "Your documentation page was created.");
    }).catch(function (e) {
      var msg;
      if (/^401|:401|403/.test(e.message)) msg = "Confluence rejected your credentials. Check your email and API token in Settings.";
      else if (/Failed to fetch|NetworkError/.test(e.message)) msg = "Couldn't reach Confluence. Confluence blocks browser CORS requests by default — use \"Copy Confluence markup\" and paste it into a new page instead.";
      else if (/:400/.test(e.message)) msg = "Confluence couldn't accept the page. Check that the Space key is correct.";
      else msg = "Couldn't publish to Confluence. Use \"Copy Confluence markup\" to paste it manually.";
      statusEl.className = "loader-status error";
      statusEl.textContent = msg;
      show(statusEl);
    });
  }

  // ---------------------------------------------------------------
  // Clipboard + download
  // ---------------------------------------------------------------
  function copyText(text, label) {
    function done() { toast("success", "Copied", label + " is on your clipboard."); }
    function fail() { toast("error", "Couldn't copy", "Your browser blocked clipboard access. Select the text manually."); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fail);
    } else {
      try {
        var ta = document.createElement("textarea");
        ta.value = text; document.body.appendChild(ta); ta.select();
        document.execCommand("copy"); document.body.removeChild(ta); done();
      } catch (e) { fail(); }
    }
  }

  function downloadMarkdown() {
    var md = $("#docs-markdown").value;
    var blob = new Blob([md], { type: "text/markdown" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = (state.apiTitle || "api").toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-docs.md";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast("success", "Download started", "Saved as " + a.download);
  }

  // ---------------------------------------------------------------
  // Modals
  // ---------------------------------------------------------------
  function openModal(node) { node.classList.remove("hidden"); }
  function closeModal(node) { node.classList.add("hidden"); }

  // ---------------------------------------------------------------
  // Mode switching
  // ---------------------------------------------------------------
  function switchMode(mode) {
    state.mode = mode;
    $("#mode-chat").classList.toggle("active", mode === "chat");
    $("#mode-docs").classList.toggle("active", mode === "docs");
    $("#view-chat").hidden = mode !== "chat";
    $("#view-docs").hidden = mode !== "docs";
  }

  // ---------------------------------------------------------------
  // Sidebar (collapse + mobile)
  // ---------------------------------------------------------------
  function isMobile() { return window.matchMedia("(max-width: 820px)").matches; }
  function toggleSidebar() {
    var app = $(".app");
    if (isMobile()) {
      var open = app.classList.toggle("sidebar-open");
      $("#sidebar-backdrop").classList.toggle("hidden", !open);
    } else {
      app.classList.toggle("sidebar-collapsed");
    }
  }
  function closeSidebarMobile() {
    if (isMobile()) {
      $(".app").classList.remove("sidebar-open");
      $("#sidebar-backdrop").classList.add("hidden");
    }
  }

  // ---------------------------------------------------------------
  // Onboarding (Feature 5)
  // ---------------------------------------------------------------
  var OB_STEPS = [
    { emoji: "📥", title: "Step 1 — Load your spec",
      body: 'A "spec" is just a file that describes your API — its endpoints, inputs, and outputs. Paste it, fetch it from a link, or point us at a GitHub repo. New here? Click <strong>"Load sample"</strong> to try the built-in TaskFlow API.' },
    { emoji: "🧭", title: "Step 2 — Explore your API",
      body: "Use the <strong>Chat</strong> tab to ask plain-English questions. The sidebar lists every endpoint — click one to ask about it instantly, or tap a quick-question chip." },
    { emoji: "📤", title: "Step 3 — Export your docs",
      body: "Switch to <strong>Generate Docs</strong> for full Markdown documentation. Then copy it, download a .md file, or publish straight to Confluence." }
  ];
  var obStep = 0;
  function showOnboarding() {
    obStep = 0; renderOnboarding(); openOverlay();
  }
  function openOverlay() { var o = $("#onboarding"); o.classList.remove("hidden"); o.setAttribute("aria-hidden", "false"); }
  function closeOnboarding() {
    var o = $("#onboarding"); o.classList.add("hidden"); o.setAttribute("aria-hidden", "true");
    localStorage.setItem(LS.onboarded, "1");
  }
  function renderOnboarding() {
    var s = OB_STEPS[obStep];
    $("#ob-emoji").textContent = s.emoji;
    $("#ob-title").textContent = s.title;
    $("#ob-body").innerHTML = s.body;
    $all("#onboarding .dot").forEach(function (d, i) { d.classList.toggle("active", i === obStep); });
    $("#onboarding-back").classList.toggle("hidden", obStep === 0);
    $("#onboarding-next").textContent = obStep === OB_STEPS.length - 1 ? "Get started" : "Next";
  }

  // ---------------------------------------------------------------
  // Settings persistence
  // ---------------------------------------------------------------
  function loadSettingsIntoForm() {
    $("#api-key-input").value = localStorage.getItem(LS.apiKey) || "";
    $("#conf-base").value = localStorage.getItem(LS.confBase) || "";
    $("#conf-space").value = localStorage.getItem(LS.confSpace) || "";
    $("#conf-email").value = localStorage.getItem(LS.confEmail) || "";
    $("#conf-token").value = localStorage.getItem(LS.confToken) || "";
  }
  function saveSettings() {
    localStorage.setItem(LS.apiKey, $("#api-key-input").value.trim());
    localStorage.setItem(LS.confBase, $("#conf-base").value.trim());
    localStorage.setItem(LS.confSpace, $("#conf-space").value.trim());
    localStorage.setItem(LS.confEmail, $("#conf-email").value.trim());
    localStorage.setItem(LS.confToken, $("#conf-token").value.trim());
    toast("success", "Settings saved", "Stored in this browser only.");
    closeModal($("#settings-modal"));
  }

  // ---------------------------------------------------------------
  // Sample spec (built-in TaskFlow) — embedded for offline use
  // ---------------------------------------------------------------
  function loadSample() {
    fetch("examples/taskflow.json").then(function (r) {
      if (!r.ok) throw new Error("nf");
      return r.json();
    }).then(function (obj) {
      $("#paste-input").value = JSON.stringify(obj, null, 2);
      loadSpecFromObject(obj, "openapi3", "the TaskFlow sample");
    }).catch(function () {
      // Fallback: embedded minimal sample if file can't be fetched (e.g. file://)
      var obj = EMBEDDED_SAMPLE;
      $("#paste-input").value = JSON.stringify(obj, null, 2);
      loadSpecFromObject(obj, "openapi3", "the TaskFlow sample");
    });
  }

  // ---------------------------------------------------------------
  // Wire up events
  // ---------------------------------------------------------------
  function init() {
    // Mode switch
    $("#mode-chat").addEventListener("click", function () { switchMode("chat"); });
    $("#mode-docs").addEventListener("click", function () { switchMode("docs"); });

    // Sidebar
    $("#sidebar-toggle").addEventListener("click", toggleSidebar);
    $("#sidebar-close").addEventListener("click", closeSidebarMobile);
    $("#sidebar-backdrop").addEventListener("click", closeSidebarMobile);

    // Loader modal
    function openLoader() { openModal($("#loader-modal")); }
    $("#open-loader-btn").addEventListener("click", openLoader);
    $("#open-loader-btn-top").addEventListener("click", openLoader);
    $("#empty-load-btn").addEventListener("click", openLoader);
    $("#docs-empty-load-btn").addEventListener("click", openLoader);
    $("#empty-sample-btn").addEventListener("click", loadSample);

    // Loader tabs
    $all("#loader-modal .tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        $all("#loader-modal .tab").forEach(function (t) { t.classList.remove("active"); });
        $all("#loader-modal .tab-panel").forEach(function (p) { p.classList.remove("active"); });
        tab.classList.add("active");
        $('#loader-modal .tab-panel[data-panel="' + tab.dataset.tab + '"]').classList.add("active");
        hide($("#loader-status"));
      });
    });

    // Loader actions
    $("#load-sample-btn").addEventListener("click", loadSample);
    $("#parse-paste-btn").addEventListener("click", function () {
      var text = $("#paste-input").value;
      try {
        var obj = parseSpecText(text);
        loadSpecFromObject(obj, null, "your pasted spec");
      } catch (e) {
        setLoaderStatus("error", e.message === "empty"
          ? "The box is empty. Paste your spec, or click \"Load sample\" to try one."
          : "That isn't valid JSON or YAML. Check for a missing bracket or quote, and try again.");
      }
    });
    $("#fetch-url-btn").addEventListener("click", function () { fetchFromUrl($("#url-input").value.trim()); });
    $("#fetch-github-btn").addEventListener("click", function () { scanGitHub($("#github-input").value.trim()); });

    // Modal close buttons + backdrop click
    $all("[data-close]").forEach(function (b) {
      b.addEventListener("click", function () { closeModal(b.closest(".modal-backdrop")); });
    });
    $all(".modal-backdrop").forEach(function (bd) {
      bd.addEventListener("click", function (e) { if (e.target === bd) closeModal(bd); });
    });

    // Coverage
    $("#open-coverage-btn").addEventListener("click", function () { openModal($("#coverage-modal")); renderCoverage(); });
    $all("#coverage-modal .filter-btn").forEach(function (b) {
      b.addEventListener("click", function () {
        $all("#coverage-modal .filter-btn").forEach(function (x) { x.classList.remove("active"); });
        b.classList.add("active");
        state.coverageFilter = b.dataset.sev;
        renderFindingsList();
      });
    });

    // Quick chips
    $all("#quick-chips .chip").forEach(function (chip) {
      chip.addEventListener("click", function () {
        switchMode("chat"); closeSidebarMobile();
        sendChat(chip.dataset.q, chip.textContent);
      });
    });

    // Chat composer
    var input = $("#chat-input");
    function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 160) + "px"; }
    input.addEventListener("input", autosize);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        var v = input.value.trim();
        if (v) { sendChat(v); input.value = ""; autosize(); }
      }
    });
    $("#chat-send").addEventListener("click", function () {
      var v = input.value.trim();
      if (v) { sendChat(v); input.value = ""; autosize(); }
    });

    // Docs
    $("#generate-docs-btn").addEventListener("click", generateDocs);
    $("#docs-markdown").addEventListener("input", function () {
      state.generatedMarkdown = $("#docs-markdown").value;
      $("#docs-preview").innerHTML = renderMarkdown(state.generatedMarkdown);
    });
    $("#copy-docs-btn").addEventListener("click", function () { copyText($("#docs-markdown").value, "The Markdown documentation"); });
    $("#download-docs-btn").addEventListener("click", downloadMarkdown);
    $("#export-confluence-btn").addEventListener("click", function () {
      $("#conf-page-title").value = state.apiTitle + " — API Documentation";
      hide($("#confluence-status"));
      openModal($("#confluence-modal"));
    });

    // Confluence
    $("#publish-confluence-btn").addEventListener("click", publishToConfluence);
    $("#copy-confluence-btn").addEventListener("click", function () {
      var markup = markdownToConfluence(state.generatedMarkdown || $("#docs-markdown").value);
      copyText(markup, "The Confluence storage-format markup");
    });

    // Settings
    $("#open-settings-btn").addEventListener("click", function () { loadSettingsIntoForm(); openModal($("#settings-modal")); });
    $("#save-settings-btn").addEventListener("click", saveSettings);

    // Onboarding
    $("#onboarding-skip").addEventListener("click", closeOnboarding);
    $("#onboarding-back").addEventListener("click", function () { if (obStep > 0) { obStep--; renderOnboarding(); } });
    $("#onboarding-next").addEventListener("click", function () {
      if (obStep < OB_STEPS.length - 1) { obStep++; renderOnboarding(); }
      else closeOnboarding();
    });
    $("#restart-tour-btn").addEventListener("click", showOnboarding);

    // Esc closes modals
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") $all(".modal-backdrop").forEach(closeModal);
    });

    // First-visit onboarding
    if (!localStorage.getItem(LS.onboarded)) showOnboarding();

    switchMode("chat");
  }

  // Embedded fallback sample (subset) for file:// usage
  var EMBEDDED_SAMPLE = {
    openapi: "3.0.3",
    info: { title: "TaskFlow API", version: "1.0.0", description: "Lightweight task and project management API with Bearer JWT auth." },
    servers: [{ url: "https://api.taskflow.dev/v1" }],
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } },
    security: [{ bearerAuth: [] }],
    paths: {
      "/auth/token": { post: { summary: "Issue an access token", description: "Exchange credentials for a JWT.", security: [],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["client_id", "client_secret"],
          properties: { client_id: { type: "string", example: "cli_live_3a9f" }, client_secret: { type: "string", example: "sec_2f7d8b1e" } } } } } },
        responses: { "200": { description: "Token issued.", content: { "application/json": { schema: { type: "object",
          properties: { access_token: { type: "string", example: "eyJhbGci..." }, token_type: { type: "string", example: "Bearer" }, expires_in: { type: "integer", example: 3600 } } } } } } } } },
      "/tasks": {
        get: { summary: "List tasks", description: "Returns tasks for the authenticated client.",
          parameters: [{ name: "status", in: "query", description: "Filter by status.", schema: { type: "string", example: "todo" } }],
          responses: { "200": { description: "A list of tasks.", content: { "application/json": { schema: { type: "object",
            properties: { data: { type: "array", items: { type: "object", properties: { task_id: { type: "string", example: "tsk_8f23" }, title: { type: "string", example: "Ship onboarding" } } } } } } } } } } },
        post: { summary: "Create a task", description: "Creates a new task.",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["title"],
            properties: { title: { type: "string", example: "Write release notes" }, priority: { type: "string", example: "medium" } } } } } },
          responses: { "201": { description: "Task created.", content: { "application/json": { schema: { type: "object", properties: { task_id: { type: "string", example: "tsk_9a01" }, title: { type: "string", example: "Write release notes" } } } } } } } } },
      "/tasks/{task_id}": {
        get: { summary: "Get a task", description: "Retrieves one task by id.",
          parameters: [{ name: "task_id", in: "path", required: true, description: "Task identifier.", schema: { type: "string", example: "tsk_8f23" } }],
          responses: { "200": { description: "The task.", content: { "application/json": { schema: { type: "object", properties: { task_id: { type: "string", example: "tsk_8f23" } } } } } } } },
        patch: { summary: "Update a task", description: "Partially updates a task.",
          parameters: [{ name: "task_id", in: "path", required: true, description: "Task identifier.", schema: { type: "string", example: "tsk_8f23" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { status: { type: "string", example: "done" } } } } } },
          responses: { "200": { description: "Updated task.", content: { "application/json": { schema: { type: "object", properties: { task_id: { type: "string", example: "tsk_8f23" }, status: { type: "string", example: "done" } } } } } } } },
        delete: { summary: "Delete a task", description: "Permanently deletes a task.",
          parameters: [{ name: "task_id", in: "path", required: true, description: "Task identifier.", schema: { type: "string", example: "tsk_8f23" } }],
          responses: { "204": { description: "Deleted." } } } },
      "/projects": {
        get: { summary: "List projects", description: "Returns all projects.",
          responses: { "200": { description: "A list of projects.", content: { "application/json": { schema: { type: "object", properties: { data: { type: "array", items: { type: "object", properties: { project_id: { type: "string", example: "prj_44" }, name: { type: "string", example: "Q3 Launch" } } } } } } } } } } },
        post: { summary: "Create a project", description: "Creates a new project.",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["name"], properties: { name: { type: "string", example: "Q3 Launch" } } } } } },
          responses: { "201": { description: "Project created.", content: { "application/json": { schema: { type: "object", properties: { project_id: { type: "string", example: "prj_45" }, name: { type: "string", example: "Q3 Launch" } } } } } } } } }
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
