import{j as t}from"./index-D4P8ElIi.js";import{r as c}from"./router-IEyAnAG6.js";const j="https://api.groq.com/openai/v1",w="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",C=["openai/gpt-oss-120b","openai/gpt-oss-20b","llama-3.3-70b-versatile","llama-3.1-8b-instant"];async function T(e,i={}){const{modelOverride:m,maxTokens:o=1e3,signal:p}=i,h=m?[m]:C;let l=null;for(const s of h)try{const n=await fetch(`${j}/chat/completions`,{method:"POST",signal:p,headers:{"Content-Type":"application/json",Authorization:`Bearer ${w}`},body:JSON.stringify({model:s,max_tokens:o,messages:e})});if(n.status===429||n.status===503){const r=await n.json().catch(()=>({}));l=new Error(r?.error?.message||`Rate limited on ${s}`);continue}if(!n.ok){const r=await n.json().catch(()=>({}));throw new Error(r?.error?.message||`Groq error: ${n.status}`)}return{content:(await n.json()).choices?.[0]?.message?.content??"",model:s}}catch(n){if(n.name==="AbortError"||(l=n,!n.message.includes("Rate limited")&&n.message!==`Rate limited on ${s}`))throw n}throw l||new Error("All Groq models failed")}function U(e){return[{role:"system",content:"You are a concise business analyst assistant. Write plain, professional summaries in 2–4 sentences. No bullet points. No markdown."},{role:"user",content:`Summarize the current state of this government contracting pipeline:
Total active opportunities: ${e.total}
Total pipeline value: ${e.totalValue}
Open opportunities: ${e.open}
Closed opportunities: ${e.closed}
Phase breakdown: ${JSON.stringify(e.byPhase)}
Overdue tasks: ${e.overdueTasks}
Top owner by deal count: ${e.topOwner}

Write a 2–4 sentence plain-English summary covering the overall pipeline state, any phase concentrations, and any urgent items.`}]}function K(e,i){return[{role:"system",content:"You are a professional proposal writer for a government contracting firm. Draft concise, professional follow-up emails. No placeholders — use the data provided."},{role:"user",content:`Draft a follow-up email for this opportunity:
Opportunity: ${e.ContractTitle}
Agency: ${e.Agency}
Phase: ${e.Phase}
Contract #: ${e.ContractNumber}
Contact name: ${i?.Name||"the contracting officer"}
Contact title: ${i?.Title||""}
Recent notes: ${e.recentNotes||"None"}

Write a professional, brief follow-up email from our team to the contact.`}]}function M(e){return[{role:"system",content:"You are a proposal writer for a government contracting firm. Write targeted capability statements that match the firm's services to a specific opportunity. Keep it to 3–4 concise paragraphs."},{role:"user",content:`Write a capability statement for this opportunity:
Opportunity: ${e.ContractTitle}
Agency: ${e.Agency}
NAICS: ${e.NAICS}
Contract #: ${e.ContractNumber}
Solicitation #: ${e.SolicitationNumber||"TBD"}
Notes: ${e.recentNotes||"None"}`}]}const S="_panel_155a8_1",E="_header_155a8_8",O="_sparkIcon_155a8_22",A="_headerTitle_155a8_24",k="_headerHint_155a8_26",I="_chevron_155a8_28",P="_chevronOpen_155a8_35",R="_body_155a8_37",L="_content_155a8_39",B="_loading_155a8_45",W="_dot_155a8_51",D="_loadingText_155a8_65",G="_error_155a8_67",Y="_meta_155a8_69",q="_modelLabel_155a8_76",z="_regenBtn_155a8_81",a={panel:S,header:E,sparkIcon:O,headerTitle:A,headerHint:k,chevron:I,chevronOpen:P,body:R,content:L,loading:B,dot:W,loadingText:D,error:G,meta:Y,modelLabel:q,regenBtn:z};function V({buildPrompt:e,title:i="AI summary",defaultCollapsed:m=!0}){const[o,p]=c.useState(!m),[h,l]=c.useState(""),[s,n]=c.useState(""),[u,_]=c.useState(!1),[r,g]=c.useState(null),[f,b]=c.useState(!1),x=c.useCallback(async()=>{if(!f){_(!0),g(null);try{const d=e(),{content:$,model:v}=await T(d,{maxTokens:300});l($),n(v),b(!0)}catch(d){d.name!=="AbortError"&&g("Failed to generate summary.")}finally{_(!1)}}},[e,f]),y=()=>{const d=!o;p(d),d&&!f&&x()},N=()=>{b(!1),l(""),x()};return t.jsxs("div",{className:a.panel,children:[t.jsxs("button",{className:a.header,onClick:y,"aria-expanded":o,children:[t.jsx("span",{className:a.sparkIcon,"aria-hidden":"true",children:"✦"}),t.jsx("span",{className:a.headerTitle,children:i}),t.jsx("span",{className:a.headerHint,children:o?"Collapse":"Click to expand"}),t.jsx("span",{className:`${a.chevron} ${o?a.chevronOpen:""}`,"aria-hidden":"true",children:"›"})]}),o&&t.jsxs("div",{className:a.body,children:[u&&t.jsxs("div",{className:a.loading,children:[t.jsx("span",{className:a.dot}),t.jsx("span",{className:a.dot}),t.jsx("span",{className:a.dot}),t.jsx("span",{className:a.loadingText,children:"Generating summary…"})]}),r&&t.jsx("p",{className:a.error,children:r}),!u&&!r&&h&&t.jsxs(t.Fragment,{children:[t.jsx("p",{className:a.content,children:h}),t.jsxs("div",{className:a.meta,children:[s&&t.jsxs("span",{className:a.modelLabel,children:["Generated with ",s]}),t.jsx("button",{className:a.regenBtn,onClick:N,children:"↺ Regenerate"})]})]})]})]})}export{V as A,K as a,U as b,M as c};
