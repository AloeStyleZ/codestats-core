// src/statsViewProvider.ts
import * as vscode from 'vscode';
import { FileStats, PromptEntry } from './types';

export class StatsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'codestat.statsView';
  private _view?: vscode.WebviewView;
  private _jumpCallback?: (line: number) => void;
  private _lastStats?: FileStats;
  private _promptHistory: PromptEntry[] = [];

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public onJumpToLine(cb: (line: number) => void) { this._jumpCallback = cb; }

  public resolveWebviewView(wv: vscode.WebviewView, _c: vscode.WebviewViewResolveContext, _t: vscode.CancellationToken) {
    this._view = wv;
    wv.webview.options = { enableScripts: true };
    wv.webview.html = this._emptyHtml();
    wv.webview.onDidReceiveMessage(d => {
      if (d.type === 'jumpToLine' && d.line && this._jumpCallback) this._jumpCallback(d.line);
      if (d.type === 'runCommand' && d.command) vscode.commands.executeCommand(d.command, ...(d.args || []));
    });
  }

  public updateStats(s: FileStats) { this._lastStats = s; this._render(); }
  public updatePromptHistory(h: PromptEntry[]) { this._promptHistory = h; this._render(); }
  private _render() { if (this._view && this._lastStats) this._view.webview.html = this._html(this._lastStats); }

  private _e(t: string) { return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

  private _type(s: FileStats): string {
    if (s.meta?.type) return s.meta.type;
    if (s.classes.some(c => c.bases.some(b => /Model|Schema/.test(b)))) return 'model';
    if (s.imports.some(i => /repository|database/.test(i.module))) return 'service';
    if (s.functions.length > 0 && s.classes.length === 0) return 'util';
    return 'module';
  }

  private _emptyHtml() {
    return `<!DOCTYPE html><html><head><style>body{font-family:'Segoe UI',sans-serif;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.e{text-align:center;opacity:.5}.e .i{font-size:48px;margin-bottom:16px}.k{background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);padding:4px 10px;border-radius:4px;font-size:12px;font-family:monospace}</style></head><body><div class="e"><div class="i">&#9889;</div><p>Abre un archivo Python</p><p style="margin-top:8px"><span class="k">Ctrl+Shift+A</span></p></div></body></html>`;
  }

  private _html(s: FileStats): string {
    const type = this._type(s);
    const name = s.meta?.name || s.fileName;
    const totalM = s.functions.length + s.classes.reduce((a,c) => a + c.methods.length, 0);

    // Build nodes
    const nodes: any[] = [];
    for (const c of s.classes) {
      const init = c.methods.find(m => m.name === '__init__');
      nodes.push({
        id:'c_'+c.name, name:c.name, kind: c.bases.some(b=>/Error|Exception/.test(b))?'error':'class',
        line:c.lineNumber, bases:c.bases, desc: s.classDescriptions[c.name]||'',
        portsIn: init?init.params.map(p=>({n:p.name,t:p.type})):[],
        portsOut: c.methods.filter(m=>m.name!=='__init__'&&m.returnType!=='Any'&&m.returnType!=='None').map(m=>({n:m.name,t:m.returnType})),
        methods: c.methods.filter(m=>m.name!=='__init__').map(m=>({
          name:m.name, sig:'('+m.params.map(p=>p.name+':'+p.type).join(', ')+') \u2192 '+m.returnType,
          async:m.isAsync, cx:m.complexity, line:m.lineNumber, priv:m.isPrivate,
          decs:m.decorators.map(d=>d.replace('@','')),
          unused: s.unused.some(u=>u.name===m.name&&u.kind==='method')
        })),
        attrs: c.attributes.map(a=>a.name+': '+a.type)
      });
    }
    for (const f of s.functions) {
      nodes.push({
        id:'f_'+f.name, name:f.name, kind:'function', line:f.lineNumber, bases:[], desc:'',
        portsIn: f.params.map(p=>({n:p.name,t:p.type})),
        portsOut:[{n:'return',t:f.returnType}], methods:[], attrs:[],
        unused: s.unused.some(u=>u.name===f.name&&u.kind==='method')
      });
    }

    // Build edges
    const cn = s.classes.map(c=>c.name);
    const es = new Set<string>(); const edges: any[] = [];
    const ae = (f:string,t:string,tp:string)=>{const k=f+'>'+t+'>'+tp;if(!es.has(k)){es.add(k);edges.push({from:f,to:t,type:tp})}};
    for (const c of s.classes) {
      for (const b of c.bases) if(cn.includes(b)) ae('c_'+b,'c_'+c.name,'inherit');
      for (const m of c.methods) for (const o of cn) {
        if(o!==c.name&&m.returnType.includes(o)) ae('c_'+c.name,'c_'+o,'dataflow');
        for(const p of m.params) if(o!==c.name&&p.type.includes(o)) ae('c_'+o,'c_'+c.name,'dep');
      }
    }
    for (const f of s.functions) for (const c of cn) {
      if(f.returnType.includes(c)||f.params.some(p=>p.type.includes(c))) ae('f_'+f.name,'c_'+c,'dataflow');
    }

    return `<!DOCTYPE html><html><head>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#0b0f19;color:#e2e8f0;overflow-x:hidden;font-size:14px}
.tb{position:sticky;top:0;z-index:100;background:rgba(11,15,25,.92);backdrop-filter:blur(12px);border-bottom:1px solid #1e2d3d;padding:12px 14px;display:flex;align-items:center;gap:10px}
.tb-n{font-family:monospace;font-weight:800;font-size:17px}
.bdg{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:1px;padding:4px 10px;border-radius:5px}
.bdg-service{background:rgba(59,130,246,.15);color:#60a5fa;border:1px solid rgba(59,130,246,.3)}
.bdg-model{background:rgba(245,158,11,.15);color:#fbbf24;border:1px solid rgba(245,158,11,.3)}
.bdg-controller{background:rgba(139,92,246,.15);color:#a78bfa;border:1px solid rgba(139,92,246,.3)}
.bdg-util{background:rgba(16,185,129,.15);color:#34d399;border:1px solid rgba(16,185,129,.3)}
.bdg-module{background:rgba(6,182,212,.15);color:#22d3ee;border:1px solid rgba(6,182,212,.3)}

/* STATS */
.sg{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:#1e2d3d;border-bottom:1px solid #1e2d3d}
.sc{background:#0b0f19;padding:14px 6px;text-align:center}
.sn{font-family:monospace;font-size:28px;font-weight:800;line-height:1}
.sn-b{color:#60a5fa}.sn-g{color:#34d399}.sn-a{color:#fbbf24}.sn-r{color:#f87171}
.sl{font-size:9px;text-transform:uppercase;letter-spacing:1.5px;color:#94a3b8;margin-top:5px;font-weight:700}

/* IO */
.io{padding:10px 14px;border-bottom:1px solid #1e2d3d}
.ior{display:flex;align-items:center;gap:10px;padding:4px 0}
.iol{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#94a3b8;width:32px;font-weight:800}
.iov{font-family:monospace;font-size:13px;font-weight:700}
.iov-i{color:#34d399}.iov-o{color:#60a5fa}

/* DESC */
.dsc{padding:12px 14px;border-bottom:1px solid #1e2d3d;background:rgba(59,130,246,.03)}
.dsc-t{font-size:12px;line-height:1.6;color:#94a3b8}

/* ═══ ACCORDION ═══ */
.acc{border-bottom:1px solid #1e2d3d}
.acc-h{display:flex;align-items:center;gap:8px;padding:12px 14px;cursor:pointer;user-select:none;transition:background .12s}
.acc-h:hover{background:rgba(255,255,255,.03)}
.acc-chev{font-size:10px;color:#475569;transition:transform .2s;width:14px;text-align:center;flex-shrink:0}
.acc.open .acc-chev{transform:rotate(90deg)}
.acc-title{font-size:11px;text-transform:uppercase;letter-spacing:2px;color:#94a3b8;font-weight:800;flex:1}
.acc-count{font-size:10px;font-weight:800;padding:2px 7px;border-radius:4px;font-family:monospace}
.acc-count-b{background:rgba(59,130,246,.15);color:#60a5fa}
.acc-count-g{background:rgba(16,185,129,.15);color:#34d399}
.acc-count-a{background:rgba(245,158,11,.15);color:#fbbf24}
.acc-count-r{background:rgba(239,68,68,.15);color:#f87171}
.acc-count-p{background:rgba(139,92,246,.15);color:#a78bfa}
.acc-body{max-height:0;overflow:hidden;transition:max-height .3s ease}
.acc.open .acc-body{max-height:5000px}
.acc-inner{padding:0 14px 12px}

/* NODE CARDS */
.nc{background:#111827;border:1px solid #1e2d3d;border-radius:8px;margin-bottom:10px;overflow:hidden;transition:all .2s}
.nc:hover{border-color:#3b82f6;box-shadow:0 0 16px rgba(59,130,246,.12)}
.nc.exp{box-shadow:0 4px 24px rgba(0,0,0,.4);border-color:#3b82f6}
.nc.active{border-color:#60a5fa;box-shadow:0 0 20px rgba(59,130,246,.2)}
.nh{padding:10px 12px;display:flex;align-items:center;gap:8px;cursor:pointer;border-bottom:1px solid #1e2d3d}
.nh:hover{background:#1a2332}.nh.active{background:#1a2f4a}
.nd{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.nd-class{background:#8b5cf6;box-shadow:0 0 6px #8b5cf6}
.nd-function{background:#10b981;box-shadow:0 0 6px #10b981}
.nd-error{background:#ef4444;box-shadow:0 0 6px #ef4444}
.nn{font-family:monospace;font-size:15px;font-weight:800;white-space:nowrap}
.nl{font-size:11px;color:#94a3b8;margin-left:auto;font-family:monospace;cursor:pointer;font-weight:700}
.nl:hover,.nl.active{color:#60a5fa}
.nba{font-size:11px;color:#94a3b8;font-family:monospace;font-weight:600}
.np{padding:6px 12px 8px;display:flex;gap:4px;flex-wrap:wrap}
.pt{font-size:11px;padding:3px 8px;border-radius:4px;font-family:monospace;border:1px solid;font-weight:700}
.pt-i{border-color:rgba(16,185,129,.35);color:#34d399;background:rgba(16,185,129,.06)}
.pt-o{border-color:rgba(59,130,246,.35);color:#60a5fa;background:rgba(59,130,246,.06)}
.ndsc{padding:8px 12px;font-size:11px;line-height:1.5;color:#64748b;border-top:1px solid rgba(30,45,61,.3);font-style:italic}
.exh{font-size:11px;color:#475569;text-align:center;padding:5px;letter-spacing:.5px}

/* METHODS */
.mg{max-height:0;overflow:hidden;transition:max-height .3s ease}
.nc.exp .mg{max-height:2000px}
.mr{display:flex;align-items:center;padding:8px 12px;border-top:1px solid rgba(30,45,61,.5);cursor:pointer;gap:6px;transition:background .12s}
.mr:hover{background:rgba(59,130,246,.1)}
.mr.active{background:rgba(59,130,246,.18);border-left:3px solid #60a5fa}
.mr.unused{opacity:.5;border-left:3px solid #475569}
.mi{font-size:14px;width:18px;text-align:center;flex-shrink:0}
.mn{font-family:monospace;font-size:14px;font-weight:800;flex-shrink:0;color:#e2e8f0}
.mn-priv{opacity:.5}
.ms{font-family:monospace;font-size:11px;color:#94a3b8;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
.mb{display:flex;gap:4px;flex-shrink:0;margin-left:auto;align-items:center}
.mbt{font-size:9px;padding:2px 5px;border-radius:3px;font-family:monospace;font-weight:800}
.mbt-a{background:rgba(6,182,212,.2);color:#22d3ee}
.mbt-l{background:rgba(71,85,105,.3);color:#94a3b8}
.mbt-d{background:rgba(139,92,246,.2);color:#a78bfa}
.mbt-u{background:rgba(71,85,105,.3);color:#64748b}
.cx{width:32px;height:4px;border-radius:2px;background:#1e2d3d;overflow:hidden;flex-shrink:0}
.cxf{height:100%;border-radius:2px}
.cxl{width:30%;background:#34d399}.cxm{width:60%;background:#fbbf24}.cxh{width:100%;background:#f87171}
.at{padding:6px 12px 8px}
.atr{display:flex;justify-content:space-between;padding:3px 0;font-size:12px}
.atl{color:#94a3b8;font-family:monospace;font-weight:700}.atv{color:#e2e8f0;font-family:monospace;font-weight:600}

/* TAGS */
.tl{display:flex;flex-wrap:wrap;gap:5px}
.ct{font-family:monospace;font-size:12px;padding:4px 10px;border-radius:5px;border:1px solid rgba(6,182,212,.3);background:rgba(6,182,212,.06);color:#22d3ee;font-weight:700;transition:all .12s}
.ct:hover{background:rgba(6,182,212,.15)}
.ct-w{border-color:rgba(245,158,11,.35);background:rgba(245,158,11,.06);color:#fbbf24}
.dt{font-family:monospace;font-size:12px;padding:4px 10px;border-radius:5px;border:1px solid rgba(245,158,11,.3);background:rgba(245,158,11,.06);color:#fbbf24;cursor:pointer;font-weight:700}
.dt:hover{background:rgba(245,158,11,.15)}

/* WARNINGS */
.wi{display:flex;align-items:flex-start;gap:8px;padding:7px 10px;margin-top:5px;background:rgba(245,158,11,.05);border-left:3px solid #fbbf24;border-radius:0 4px 4px 0;font-size:13px;color:#e2e8f0;line-height:1.4;font-weight:600}

/* TRUST SCORE */
/* EXTERNAL USAGE */
.eu-row{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid rgba(30,45,61,.2)}
.eu-kind{font-size:8px;font-weight:800;text-transform:uppercase;padding:2px 6px;border-radius:3px;flex-shrink:0}
.eu-class{background:rgba(139,92,246,.2);color:#a78bfa}
.eu-method{background:rgba(59,130,246,.2);color:#60a5fa}
.eu-function{background:rgba(16,185,129,.2);color:#34d399}
.eu-name{font-family:monospace;font-weight:700;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.eu-count{font-size:10px;color:#94a3b8;flex-shrink:0;font-weight:700}
.eu-files{display:flex;flex-wrap:wrap;gap:4px;padding:2px 0 8px 0}
.eu-file{font-size:10px;font-family:monospace;padding:2px 6px;border-radius:3px;background:rgba(71,85,105,.15);color:#94a3b8}
.sn-p{color:#a78bfa}

/* HARDCODED */
.hc-row{display:flex;align-items:center;padding:6px 0;gap:8px;border-bottom:1px solid rgba(30,45,61,.3);cursor:pointer;font-size:12px}
.hc-row:hover{background:rgba(239,68,68,.05)}
.hc-row:last-child{border-bottom:none}
.hc-type{font-size:8px;font-weight:800;text-transform:uppercase;padding:2px 6px;border-radius:3px;flex-shrink:0}
.hc-cred{background:rgba(239,68,68,.2);color:#f87171}
.hc-url{background:rgba(59,130,246,.2);color:#60a5fa}
.hc-str{background:rgba(139,92,246,.2);color:#a78bfa}
.hc-num{background:rgba(245,158,11,.2);color:#fbbf24}
.hc-ip{background:rgba(236,72,153,.2);color:#f472b6}
.hc-path{background:rgba(16,185,129,.2);color:#34d399}
.hc-val{font-family:monospace;font-weight:700;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hc-ln{font-size:10px;color:#94a3b8;font-family:monospace;font-weight:700;flex-shrink:0}

/* UNUSED */
.un-row{display:flex;align-items:center;padding:6px 0;gap:8px;border-bottom:1px solid rgba(30,45,61,.3);cursor:pointer;font-size:13px;font-weight:700}
.un-row:hover{background:rgba(71,85,105,.08)}
.un-row:last-child{border-bottom:none}
.un-kind{font-size:8px;font-weight:800;text-transform:uppercase;padding:2px 6px;border-radius:3px;flex-shrink:0}
.un-imp{background:rgba(6,182,212,.2);color:#22d3ee}
.un-met{background:rgba(139,92,246,.2);color:#a78bfa}
.un-var{background:rgba(245,158,11,.2);color:#fbbf24}
.un-name{font-family:monospace;flex:1}
.un-ln{font-size:10px;color:#94a3b8;font-family:monospace;flex-shrink:0}

/* DIAGNOSTICS / ERROR BUTTONS */
.dg-btn{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;margin:3px 0;border-radius:5px;cursor:pointer;font-size:12px;font-weight:700;font-family:monospace;transition:all .12s;border:1px solid;max-width:100%;overflow:hidden}
.dg-btn:hover{filter:brightness(1.2)}
.dg-btn.dg-error{background:rgba(239,68,68,.1);border-color:rgba(239,68,68,.3);color:#f87171}
.dg-btn.dg-warning{background:rgba(245,158,11,.1);border-color:rgba(245,158,11,.3);color:#fbbf24}
.dg-btn.dg-info{background:rgba(59,130,246,.1);border-color:rgba(59,130,246,.3);color:#60a5fa}
.dg-btn .dg-ico{flex-shrink:0}
.dg-btn .dg-txt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dg-btn .dg-ln{font-size:9px;opacity:.7;flex-shrink:0;margin-left:auto}
.dg-copied{position:fixed;bottom:12px;left:50%;transform:translateX(-50%);background:#34d399;color:#0b0f19;padding:6px 14px;border-radius:6px;font-size:12px;font-weight:800;z-index:999;opacity:0;transition:opacity .2s}
.dg-copied.show{opacity:1}

/* DEPS */
.dep-row{display:flex;align-items:center;padding:6px 0;gap:8px;border-bottom:1px solid rgba(30,45,61,.3);cursor:pointer;font-size:13px;font-weight:700}
.dep-row:hover{background:rgba(59,130,246,.05)}
.dep-row:last-child{border-bottom:none}
.dep-st{width:18px;text-align:center;flex-shrink:0;font-size:14px}
.dep-installed{color:#34d399}.dep-missing{color:#f87171}.dep-unknown{color:#94a3b8}
.dep-name{font-family:monospace;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dep-badge{font-size:8px;font-weight:800;text-transform:uppercase;padding:2px 6px;border-radius:3px;flex-shrink:0}
.dep-badge.dep-installed{background:rgba(16,185,129,.15);color:#34d399}
.dep-badge.dep-missing{background:rgba(239,68,68,.15);color:#f87171}
.dep-badge.dep-unknown{background:rgba(71,85,105,.2);color:#94a3b8}
.dep-install{font-size:10px;font-weight:800;font-family:monospace;padding:3px 8px;border-radius:4px;background:rgba(239,68,68,.15);color:#f87171;border:1px solid rgba(239,68,68,.3);cursor:pointer;flex-shrink:0;transition:all .12s}
.dep-install:hover{background:rgba(239,68,68,.25);filter:brightness(1.2)}
.dep-install-btn{font-size:10px;font-weight:800;padding:4px 10px;border-radius:4px;background:rgba(239,68,68,.15);color:#f87171;border:1px solid rgba(239,68,68,.3);cursor:pointer;flex-shrink:0;transition:all .12s}
.dep-install-btn:hover{background:rgba(239,68,68,.3)}
.dep-verify-btn{text-align:center;padding:8px 12px;margin-bottom:8px;border-radius:6px;font-size:13px;font-weight:800;cursor:pointer;background:rgba(59,130,246,.12);border:1px solid rgba(59,130,246,.3);color:#60a5fa;transition:all .15s}
.dep-verify-btn:hover{background:rgba(59,130,246,.22);filter:brightness(1.1)}

/* TODOS */
.todo-row{display:flex;align-items:center;padding:6px 0;gap:8px;border-bottom:1px solid rgba(30,45,61,.3);cursor:pointer;font-size:12px}
.todo-row:hover{background:rgba(245,158,11,.05)}
.todo-row:last-child{border-bottom:none}
.todo-type{font-size:8px;font-weight:800;text-transform:uppercase;padding:2px 6px;border-radius:3px;flex-shrink:0}
.todo-todo{background:rgba(59,130,246,.2);color:#60a5fa}
.todo-fixme{background:rgba(239,68,68,.2);color:#f87171}
.todo-hack{background:rgba(245,158,11,.2);color:#fbbf24}
.todo-bug{background:rgba(236,72,153,.2);color:#f472b6}
.todo-note{background:rgba(16,185,129,.2);color:#34d399}
.todo-text{flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.todo-ln{font-size:10px;color:#94a3b8;font-family:monospace;font-weight:700;flex-shrink:0}

/* PROMPT HISTORY */
.ph-row{display:flex;align-items:center;padding:5px 0;gap:8px;border-bottom:1px solid rgba(30,45,61,.2);font-size:11px}
.ph-type{font-size:8px;font-weight:800;text-transform:uppercase;padding:2px 6px;border-radius:3px;flex-shrink:0}
.ph-generate{background:rgba(16,185,129,.2);color:#34d399}
.ph-convert{background:rgba(59,130,246,.2);color:#60a5fa}
.ph-snippet{background:rgba(139,92,246,.2);color:#a78bfa}
.ph-file{font-family:monospace;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ph-time{color:#64748b;font-family:monospace;flex-shrink:0;font-size:10px}
.ph-more{text-align:center;padding:6px;font-size:11px;color:#60a5fa;cursor:pointer;font-weight:700}
.ph-more:hover{text-decoration:underline}

/* ACTIONS */
.act-row{padding:8px 10px;font-size:13px;font-weight:700;cursor:pointer;border-radius:5px;transition:background .12s;margin-bottom:3px}
.act-row:hover{background:rgba(59,130,246,.1)}

.ec{position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:1}
.el{fill:none;stroke-width:1.5;opacity:.35}
::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:#1e2d3d;border-radius:2px}
</style></head><body>

<!-- TOPBAR -->
<div class="tb">
  <span style="font-size:18px">&#9889;</span>
  <span class="tb-n">${this._e(name)}</span>
  <span class="bdg bdg-${type}">${type}</span>
</div>

<!-- STATS -->
<div class="sg">
  <div class="sc"><div class="sn sn-b">${s.connections.length}</div><div class="sl">Deps</div></div>
  <div class="sc"><div class="sn sn-g">${totalM}</div><div class="sl">M\u00e9todos</div></div>
  <div class="sc"><div class="sn sn-p">${s.externalUsage.length}</div><div class="sl">Uso ext.</div></div>
  <div class="sc"><div class="sn sn-a">${s.errorTypes.length}</div><div class="sl">Excepciones</div></div>
</div>

<!-- IO -->
${s.meta?.inputs||s.meta?.outputs?`<div class="io">
  ${s.meta?.inputs?`<div class="ior"><span class="iol">IN</span><span class="iov iov-i">${this._e(s.meta.inputs.join(', '))}</span></div>`:''}
  ${s.meta?.outputs?`<div class="ior"><span class="iol">OUT</span><span class="iov iov-o">${this._e(s.meta.outputs.join(', '))}</span></div>`:''}
</div>`:''}

<!-- DESC -->
<div class="dsc"><div class="dsc-t">${this._e(s.description)}</div></div>

<!-- ═══ USO EXTERNO ═══ -->
${s.externalUsage.length > 0 ? `
<div class="acc open" data-acc="extuse">
  <div class="acc-h" onclick="T('extuse')">
    <span class="acc-chev">\u25B6</span>
    <span class="acc-title">Uso externo</span>
    <span class="acc-count acc-count-p">${s.externalUsage.length}</span>
  </div>
  <div class="acc-body"><div class="acc-inner">
    ${s.externalUsage.map(eu => `
      <div class="eu-row">
        <span class="eu-kind eu-${eu.kind}">${eu.kind === 'class' ? 'CLASS' : eu.kind === 'function' ? 'FUNC' : 'METHOD'}</span>
        <span class="eu-name">${this._e(eu.name)}</span>
        <span class="eu-count">${eu.usedIn.length} archivo${eu.usedIn.length > 1 ? 's' : ''}</span>
      </div>
      <div class="eu-files">${eu.usedIn.map(f => `<span class="eu-file">${this._e(f)}</span>`).join('')}</div>
    `).join('')}
  </div></div>
</div>` : ''}

<!-- ═══ COMPONENT MAP ═══ -->
<div class="acc open" data-acc="map">
  <div class="acc-h" onclick="T('map')">
    <span class="acc-chev">\u25B6</span>
    <span class="acc-title">Componentes</span>
    <span class="acc-count acc-count-g">${s.classes.length + s.functions.length}</span>
  </div>
  <div class="acc-body"><div class="acc-inner">
    <div id="fc" style="position:relative">
      <svg id="esvg" class="ec"></svg>
      <div id="nc"></div>
    </div>
  </div></div>
</div>

<!-- ═══ CONNECTIONS ═══ -->
<div class="acc" data-acc="conn">
  <div class="acc-h" onclick="T('conn')">
    <span class="acc-chev">\u25B6</span>
    <span class="acc-title">Conexiones externas</span>
    <span class="acc-count acc-count-b">${s.connections.length}</span>
  </div>
  <div class="acc-body"><div class="acc-inner">
    <div class="tl">${s.connections.map(c => {
      const w = s.warnings.some(x=>x.includes(c));
      return `<span class="ct${w?' ct-w':''}">${this._e(c)}</span>`;
    }).join('')}</div>
  </div></div>
</div>

<!-- ═══ HARDCODED VALUES ═══ -->
${s.hardcoded.length > 0 ? `
<div class="acc open" data-acc="hard">
  <div class="acc-h" onclick="T('hard')">
    <span class="acc-chev">\u25B6</span>
    <span class="acc-title">Hardcoded</span>
    <span class="acc-count acc-count-r">${s.hardcoded.length}</span>
  </div>
  <div class="acc-body"><div class="acc-inner">
    ${s.hardcoded.map(h => `
      <div class="hc-row" data-jump="${h.lineNumber}">
        <span class="hc-type hc-${h.type}">${h.type}</span>
        <span class="hc-val">${this._e(h.value)}</span>
        <span class="hc-ln">L${h.lineNumber}</span>
      </div>`).join('')}
  </div></div>
</div>` : ''}

<!-- ═══ UNUSED CODE ═══ -->
${s.unused.length > 0 ? `
<div class="acc open" data-acc="unused">
  <div class="acc-h" onclick="T('unused')">
    <span class="acc-chev">\u25B6</span>
    <span class="acc-title">C\u00f3digo sin uso</span>
    <span class="acc-count acc-count-p">${s.unused.length}</span>
  </div>
  <div class="acc-body"><div class="acc-inner">
    ${s.unused.map(u => `
      <div class="un-row" data-jump="${u.lineNumber}">
        <span class="un-kind un-${u.kind==='import'?'imp':u.kind==='method'?'met':'var'}">${u.kind}</span>
        <span class="un-name">${this._e(u.name)}</span>
        <span class="un-ln">L${u.lineNumber}</span>
      </div>`).join('')}
  </div></div>
</div>` : ''}

<!-- ═══ DEBUG POINTS ═══ -->
${s.debugPoints.length > 0 ? `
<div class="acc" data-acc="debug">
  <div class="acc-h" onclick="T('debug')">
    <span class="acc-chev">\u25B6</span>
    <span class="acc-title">Debug points</span>
    <span class="acc-count acc-count-a">${s.debugPoints.length}</span>
  </div>
  <div class="acc-body"><div class="acc-inner">
    <div class="tl">${s.debugPoints.map(p => `<span class="dt" data-jump="${p}">L${p}</span>`).join('')}</div>
  </div></div>
</div>` : ''}

<!-- ═══ WARNINGS ═══ -->
${s.warnings.length > 0 ? `
<div class="acc open" data-acc="warn">
  <div class="acc-h" onclick="T('warn')">
    <span class="acc-chev">\u25B6</span>
    <span class="acc-title">\u26a0 Alertas</span>
    <span class="acc-count acc-count-a">${s.warnings.length}</span>
  </div>
  <div class="acc-body"><div class="acc-inner">
    ${s.warnings.map(w => `<div class="wi"><span>\u26a0</span><span>${this._e(w)}</span></div>`).join('')}
  </div></div>
</div>` : ''}

<!-- ═══ ERRORES DE COMPILACIÓN ═══ -->
${s.diagnostics.length > 0 ? `
<div class="acc open" data-acc="diag">
  <div class="acc-h" onclick="T('diag')">
    <span class="acc-chev">\u25B6</span>
    <span class="acc-title">Errores</span>
    <span class="acc-count ${s.diagnostics.some(d => d.severity === 'error') ? 'acc-count-r' : 'acc-count-a'}">${s.diagnostics.length}</span>
  </div>
  <div class="acc-body"><div class="acc-inner">
    ${s.diagnostics.map((d, i) => {
      const shortMsg = d.message.split('\n')[0].slice(0, 60) + (d.message.length > 60 ? '...' : '');
      const fullDetail = `[${d.severity.toUpperCase()}] L${d.lineNumber}: ${d.message}${d.source ? '\\nSource: ' + d.source : ''}${d.code ? '\\nCode: ' + d.code : ''}`;
      return `<div class="dg-btn dg-${d.severity}" data-err="${this._e(fullDetail.replace(/"/g, '&quot;'))}" data-jump="${d.lineNumber}">
        <span class="dg-ico">${d.severity === 'error' ? '\u2716' : d.severity === 'warning' ? '\u26a0' : '\u24d8'}</span>
        <span class="dg-txt">${this._e(shortMsg)}</span>
        <span class="dg-ln">L${d.lineNumber}</span>
      </div>`;
    }).join('')}
  </div></div>
</div>
<div class="dg-copied" id="cpToast">Error copiado</div>` : ''}

<!-- toast for copy actions (always present) -->
<div class="dg-copied" id="cpToast2">Copiado al clipboard</div>

<!-- ═══ DEPENDENCY HEALTH ═══ -->
${s.depIssues.length > 0 ? `
<div class="acc${s.depIssues.some(d => d.status === 'missing') ? ' open' : ''}" data-acc="deps">
  <div class="acc-h" onclick="T('deps')">
    <span class="acc-chev">\u25B6</span>
    <span class="acc-title">Dependencias</span>
    <span class="acc-count ${s.depIssues.some(d => d.status === 'missing') ? 'acc-count-r' : 'acc-count-g'}">${s.depIssues.length}</span>
  </div>
  <div class="acc-body"><div class="acc-inner">
    <div class="dep-verify-btn" onclick="V.postMessage({type:'runCommand',command:'codestat.verifyDeps'})">\u{1F50D} Verificar dependencias</div>
    ${s.depIssues.map(d => `
      <div class="dep-row">
        <span class="dep-st dep-${d.status}">${d.status === 'installed' ? '\u2713' : d.status === 'missing' ? '\u2716' : '?'}</span>
        <span class="dep-name" data-jump="${d.lineNumber}">${this._e(d.name)}</span>
        ${d.status === 'installed'
          ? `<span class="dep-badge dep-installed">\u2713</span>`
          : d.installCmd
            ? `<span class="dep-install-btn" onclick="V.postMessage({type:'runCommand',command:'codestat.installDep',args:['${this._e(d.name)}','${this._e(d.installCmd)}']})">\u25B6 Instalar</span>`
            : `<span class="dep-badge dep-unknown">?</span>`
        }
      </div>`).join('')}
  </div></div>
</div>` : ''}

<!-- ═══ TODO / FIXME ═══ -->
${s.todos.length > 0 ? `
<div class="acc open" data-acc="todos">
  <div class="acc-h" onclick="T('todos')">
    <span class="acc-chev">\u25B6</span>
    <span class="acc-title">TODO / FIXME</span>
    <span class="acc-count acc-count-a">${s.todos.length}</span>
  </div>
  <div class="acc-body"><div class="acc-inner">
    ${s.todos.map(t => `
      <div class="todo-row" data-jump="${t.lineNumber}">
        <span class="todo-type todo-${t.type.toLowerCase()}">${t.type}</span>
        <span class="todo-text">${this._e(t.text)}</span>
        <span class="todo-ln">L${t.lineNumber}</span>
      </div>`).join('')}
  </div></div>
</div>` : ''}

<!-- ═══ PROMPT HISTORY ═══ -->
${this._promptHistory.length > 0 ? `
<div class="acc" data-acc="prompts">
  <div class="acc-h" onclick="T('prompts')">
    <span class="acc-chev">\u25B6</span>
    <span class="acc-title">Prompt History</span>
    <span class="acc-count acc-count-p">${this._promptHistory.length}</span>
  </div>
  <div class="acc-body"><div class="acc-inner">
    ${this._promptHistory.slice(-5).reverse().map(p => `
      <div class="ph-row">
        <span class="ph-type ph-${p.type}">${p.type}</span>
        <span class="ph-file">${this._e(p.fileName)}</span>
        <span class="ph-time">${new Date(p.timestamp).toLocaleTimeString()}</span>
      </div>`).join('')}
    <div class="ph-more" onclick="V.postMessage({type:'runCommand',command:'codestat.showPromptHistory'})">Ver todo \u2192</div>
  </div></div>
</div>` : ''}

<!-- ═══ QUICK ACTIONS ═══ -->
<div class="acc open" data-acc="actions">
  <div class="acc-h" onclick="T('actions')">
    <span class="acc-chev">\u25B6</span>
    <span class="acc-title">Acciones</span>
  </div>
  <div class="acc-body"><div class="acc-inner">
    <div class="act-row" onclick="V.postMessage({type:'runCommand',command:'codestat.extractSnippet'})">&#9889; Extraer prompt de m\u00e9todo</div>
    <div class="act-row" onclick="V.postMessage({type:'runCommand',command:'codestat.copyConvertPrompt'})">&#128196; Convertir a formato CodeStat</div>
    <div class="act-row" onclick="V.postMessage({type:'runCommand',command:'codestat.copyPrompt'})">&#128203; Copiar prompt para generar</div>
    <div class="act-row" onclick="V.postMessage({type:'runCommand',command:'codestat.showPromptHistory'})">&#128340; Historial de prompts</div>
  </div></div>
</div>

<script>
const V=acquireVsCodeApi();
function J(l){V.postMessage({type:'jumpToLine',line:l})}

// ═══ ACCORDION ═══
function T(id){
  var a=document.querySelector('[data-acc="'+id+'"]');
  if(a)a.classList.toggle('open');
}

// ═══ NODES ═══
const nodes=${JSON.stringify(nodes)};
const edges=${JSON.stringify(edges)};
const nc=document.getElementById('nc');
const svg=document.getElementById('esvg');
const pos={};
let yy=0;
const GAP=8;

nodes.forEach(function(n){
  var d=document.createElement('div');
  d.className='nc';d.id='n_'+n.id;d.style.position='relative';d.style.marginBottom=GAP+'px';
  var h='';
  var ha=n.methods.length>0?'data-toggle="'+n.id+'"':'data-jump="'+n.line+'"';
  h+='<div class="nh" '+ha+'>';
  h+='<span class="nd nd-'+n.kind+'"></span>';
  h+='<span class="nn">'+n.name+'</span>';
  if(n.bases&&n.bases.length)h+='<span class="nba">('+n.bases.join(', ')+')</span>';
  if(n.unused)h+='<span class="mbt mbt-u">sin uso</span>';
  h+='<span class="nl" data-jump="'+n.line+'">L'+n.line+'</span>';
  h+='</div>';

  if(n.portsIn.length||n.portsOut.length){
    h+='<div class="np">';
    n.portsIn.forEach(function(p){h+='<span class="pt pt-i" title="'+p.t+'">\\u25B6 '+p.n+'</span>'});
    n.portsOut.forEach(function(p){h+='<span class="pt pt-o" title="'+p.t+'">'+p.n+' \\u25B6</span>'});
    h+='</div>';
  }
  if(n.desc)h+='<div class="ndsc">'+n.desc+'</div>';
  if(n.methods.length>0)h+='<div class="exh">\\u25BC '+n.methods.length+' m\\u00e9todo'+(n.methods.length>1?'s':'')+'</div>';
  if(n.methods.length){
    h+='<div class="mg">';
    n.methods.forEach(function(m){
      var cx=m.cx<=2?'cxl':m.cx<=5?'cxm':'cxh';
      h+='<div class="mr'+(m.unused?' unused':'')+'" data-jump="'+m.line+'">';
      h+='<span class="mi">'+(m.async?'\\u26a1':'\\u25b8')+'</span>';
      h+='<span class="mn'+(m.priv?' mn-priv':'')+'">'+m.name+'</span>';
      h+='<span class="ms">'+m.sig+'</span>';
      h+='<div class="mb">';
      m.decs.forEach(function(dd){h+='<span class="mbt mbt-d">@'+dd+'</span>'});
      if(m.async)h+='<span class="mbt mbt-a">async</span>';
      if(m.unused)h+='<span class="mbt mbt-u">sin uso</span>';
      h+='<span class="mbt mbt-l">L'+m.line+'</span>';
      h+='<div class="cx"><div class="cxf '+cx+'"></div></div>';
      h+='</div></div>';
    });
    h+='</div>';
  }
  if(n.attrs&&n.attrs.length){
    h+='<div class="mg"><div class="at">';
    n.attrs.forEach(function(a){var p=a.split(': ');h+='<div class="atr"><span class="atl">'+p[0]+'</span><span class="atv">'+(p[1]||'Any')+'</span></div>'});
    h+='</div></div>';
  }
  d.innerHTML=h;nc.appendChild(d);
  var ch=d.offsetHeight||60;
  pos[n.id]={top:yy,h:ch};
  yy+=ch+GAP;
});
document.getElementById('fc').style.minHeight=yy+'px';

// ═══ CLICKS ═══
function clrA(){document.querySelectorAll('.active').forEach(function(e){e.classList.remove('active')})}
function showToast(){var t=document.getElementById('cpToast')||document.getElementById('cpToast2');if(t){t.classList.add('show');setTimeout(function(){t.classList.remove('show')},1500)}}
document.addEventListener('click',function(e){
  var el=e.target;
  while(el&&el!==document.body){
    // Error button: copy full error + jump to line
    if(el.hasAttribute&&el.hasAttribute('data-err')){
      e.stopPropagation();
      var errText=el.getAttribute('data-err').replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'");
      navigator.clipboard.writeText(errText).then(function(){showToast()});
      var errLine=el.getAttribute('data-jump');
      if(errLine){var ln=parseInt(errLine,10);if(ln>0)J(ln)}
      return;
    }
    // Install cmd: copy pip install / npm install
    if(el.hasAttribute&&el.hasAttribute('data-cmd')){
      e.stopPropagation();
      navigator.clipboard.writeText(el.getAttribute('data-cmd')).then(function(){showToast()});
      return;
    }
    if(el.hasAttribute&&el.hasAttribute('data-jump')){
      e.stopPropagation();clrA();
      el.classList.add('active');
      var pc=el.closest('.nc');if(pc)pc.classList.add('active');
      var l=parseInt(el.getAttribute('data-jump'),10);
      if(l>0)J(l);return;
    }
    if(el.hasAttribute&&el.hasAttribute('data-toggle')){
      clrA();
      var nid=el.getAttribute('data-toggle');
      var card=document.getElementById('n_'+nid);
      if(card){card.classList.toggle('exp');card.classList.add('active');el.classList.add('active');
        var hint=card.querySelector('.exh');if(hint)hint.style.display=card.classList.contains('exp')?'none':'block';
        setTimeout(rePos,350);
      }return;
    }
    el=el.parentElement;
  }
});

// ═══ EDGES ═══
function drawE(){
  var s='';
  edges.forEach(function(e){
    var f=pos[e.from],t=pos[e.to];if(!f||!t)return;
    var y1=f.top+f.h/2,y2=t.top+t.h/2;
    var st=e.type==='dep'?'#22d3ee':e.type==='inherit'?'#a78bfa':'#60a5fa';
    var da=e.type==='dep'?' stroke-dasharray="4 3"':e.type==='inherit'?' stroke-dasharray="6 3"':'';
    s+='<path class="el" d="M4,'+y1+' C-14,'+y1+' -14,'+y2+' 4,'+y2+'" stroke="'+st+'"'+da+'/>';
    s+='<circle cx="4" cy="'+y2+'" r="2.5" fill="'+st+'" opacity=".5"/>';
  });
  svg.innerHTML=s;svg.style.height=yy+'px';
}
function rePos(){
  var y=0;nodes.forEach(function(n){var e=document.getElementById('n_'+n.id);if(!e)return;var h=e.offsetHeight;pos[n.id]={top:y,h:h};y+=h+GAP});
  yy=y;document.getElementById('fc').style.minHeight=y+'px';drawE();
}
drawE();
</script></body></html>`;
  }
}
