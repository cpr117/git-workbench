'use strict';
const root=document.documentElement;
const systemDark=()=>matchMedia('(prefers-color-scheme: dark)').matches;
let preference;try{preference=localStorage.getItem('git-guide-theme')}catch{}
if(['light','dark'].includes(preference))root.dataset.theme=preference;
const themeButton=document.querySelector('#theme');
const isDark=()=>root.dataset.theme?root.dataset.theme==='dark':systemDark();
function labelTheme(){themeButton.textContent=isDark()?'浅色':'深色';themeButton.setAttribute('aria-label',isDark()?'切换为浅色主题':'切换为深色主题')}
function notifyFrames(){for(const frame of document.querySelectorAll('iframe'))frame.contentWindow?.postMessage({type:'guideTheme',dark:isDark()},'*')}
function applyTheme(){labelTheme();notifyFrames()}
themeButton.addEventListener('click',()=>{root.dataset.theme=isDark()?'light':'dark';try{localStorage.setItem('git-guide-theme',root.dataset.theme)}catch{}applyTheme()});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>{if(!root.dataset.theme)applyTheme()});
const demoTimers=new Map();
const demoFrames=[...document.querySelectorAll('iframe[data-demo]')];
function failDemo(frame){frame.parentElement.classList.remove('demo-ready');frame.parentElement.querySelector('[data-demo-status]').textContent='演示暂时未能加载。可重试、单独打开，或继续阅读下方使用指南。'}
function loadDemo(frame){
 clearTimeout(demoTimers.get(frame));frame.parentElement.classList.remove('demo-ready');
 frame.parentElement.querySelector('[data-demo-status]').textContent='正在加载交互演示…';
 const html=window.GitWorkbenchDemos?.[frame.dataset.demo];
 if(!html){failDemo(frame);return}
 frame.srcdoc=html;
 demoTimers.set(frame,setTimeout(()=>failDemo(frame),8000));
}
window.addEventListener('message',event=>{
 const frame=demoFrames.find(frame=>frame.contentWindow===event.source);if(!frame)return;
 if(event.data?.type==='demoReady'){clearTimeout(demoTimers.get(frame));frame.parentElement.classList.add('demo-ready');notifyFrames()}
 else if(event.data?.type==='demoFailed'){clearTimeout(demoTimers.get(frame));failDemo(frame)}
});
for(const frame of demoFrames){frame.parentElement.querySelector('[data-retry-demo]').addEventListener('click',()=>loadDemo(frame));loadDemo(frame)}
for(const frame of document.querySelectorAll('iframe'))frame.addEventListener('load',notifyFrames);
applyTheme();
const commands={vscode:['code --install-extension ./git-workbench-0.13.1.vsix','使用 code CLI，将安装到它所指向的 VS Code。'],cursor:['cursor --install-extension ./git-workbench-0.13.1.vsix','使用 Cursor 的命令行工具；如尚未配置，可从扩展面板安装。'],qoder:['"/Applications/Qoder IDE.app/Contents/Resources/app/bin/qoder" --install-extension ./git-workbench-0.13.1.vsix --force','此路径用于 macOS。安装后执行 Developer: Reload Window。']};
function selectEditor(tab){for(const item of document.querySelectorAll('[data-editor]')){const active=item===tab;item.setAttribute('aria-selected',String(active));item.tabIndex=active?0:-1}document.querySelector('#command-panel').setAttribute('aria-labelledby',tab.id);document.querySelector('#install-command').textContent=commands[tab.dataset.editor][0];document.querySelector('#command-help').textContent=commands[tab.dataset.editor][1]}
for(const tab of document.querySelectorAll('[data-editor]')){tab.addEventListener('click',()=>selectEditor(tab));tab.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const tabs=[...document.querySelectorAll('[data-editor]')];let index=event.key==='Home'?0:event.key==='End'?tabs.length-1:(tabs.indexOf(tab)+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;selectEditor(tabs[index]);tabs[index].focus()})}
let toastTimer;function toast(text){const el=document.querySelector('#toast');el.textContent=text;el.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.hidden=true,3200)}
async function copy(text){try{await navigator.clipboard.writeText(text);toast('已复制')}catch{toast('浏览器未允许自动复制，请手动选择并复制代码。')}}
document.querySelector('#copy-command').addEventListener('click',()=>copy(document.querySelector('#install-command').textContent));for(const button of document.querySelectorAll('[data-copy]'))button.addEventListener('click',()=>copy(button.dataset.copy));
const guideLinks=[...document.querySelectorAll('.guide-index a')];const observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){for(const link of guideLinks)link.classList.toggle('active',link.hash==='#'+entry.target.id)}},{rootMargin:'-100px 0px -55% 0px'});for(const article of document.querySelectorAll('.guide-content>article'))observer.observe(article);
