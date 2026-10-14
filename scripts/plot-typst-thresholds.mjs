import { readFile, writeFile } from 'node:fs/promises';
const directory = new URL('../reports/typst-thresholds/', import.meta.url);
const results = JSON.parse(await readFile(new URL('results.json', directory), 'utf8'));
const colors = ['#2563eb', '#059669', '#d97706', '#9333ea', '#dc2626'];
const thresholds = [256, 512, 1024, 2048, 'none'];
const escape = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
function chart(corpus) {
  const rows = results.filter(row => row.corpus === corpus);
  const width = 900, height = 370, left = 65, top = 25, pw = 800, ph = 270;
  const maxX = Math.max(...rows.map(row => row.compilations));
  const maxY = Math.ceil(Math.max(...rows.map(row => row.peakTotalRssMiB)) / 100) * 100;
  const x = value => left + value / maxX * pw, y = value => top + ph - value / maxY * ph;
  let svg = '<svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="Combined RSS against compilation count">';
  svg += '<rect width="100%" height="100%" fill="white"/>';
  for (let tick = 0; tick <= 5; tick++) {
    const value = maxY * tick / 5;
    svg += '<path d="M' + left + ' ' + y(value) + 'h' + pw + '" stroke="#e2e8f0"/>';
    svg += '<text x="' + (left-10) + '" y="' + (y(value)+4) + '" text-anchor="end">' + value + '</text>';
  }
  for (let tick = 0; tick <= 4; tick++) {
    const value = maxX * tick / 4;
    svg += '<text x="' + x(value) + '" y="' + (top+ph+24) + '" text-anchor="middle">' + value + '</text>';
  }
  rows.forEach(row => {
    const color = colors[thresholds.indexOf(row.threshold)];
    const points = row.samples.map(point => x(point.compilations).toFixed(1) + ',' + y(point.totalRssMiB).toFixed(1)).join(' ');
    svg += '<polyline fill="none" stroke="' + color + '" stroke-width="1.6" opacity="' + (row.repetition === 1 ? '.95' : '.45') + '" points="' + points + '"/>';
  });
  thresholds.forEach((threshold, i) => {
    svg += '<rect x="' + (left+i*150) + '" y="342" width="14" height="4" fill="' + colors[i] + '"/>';
    svg += '<text x="' + (left+i*150+20) + '" y="348">' + (threshold === 'none' ? 'No recycle' : threshold + ' compiles') + '</text>';
  });
  svg += '<text x="8" y="17">MiB</text><text x="865" y="320" text-anchor="end">Compilations</text></svg>';
  return svg;
}
const average = values => values.reduce((sum,value)=>sum+value,0)/values.length;
let table = '<table><thead><tr><th>Workload</th><th>Threshold</th><th>Trials</th><th>Peak total MiB (worst)</th><th>Total seconds (mean)</th><th>Cold compile ms (mean median)</th><th>Process starts per trial</th></tr></thead><tbody>';
for (const corpus of ['short','note']) for (const threshold of thresholds) {
  const rows = results.filter(row=>row.corpus===corpus&&row.threshold===threshold);
  if (!rows.length) continue;
  table += '<tr><td>'+corpus+'</td><td>'+threshold+'</td><td>'+rows.length+'</td><td>'+
    Math.max(...rows.map(row=>row.peakTotalRssMiB)).toFixed(1)+'</td><td>'+
    average(rows.map(row=>row.elapsedSeconds)).toFixed(2)+'</td><td>'+
    average(rows.map(row=>row.coldMedianMs)).toFixed(1)+'</td><td>'+rows[0].starts+'</td></tr>';
}
table += '</tbody></table>';
const html = '<!doctype html><meta charset="utf-8"><title>Typst recycling threshold measurements</title>'+
  '<style>body{font:15px system-ui;margin:32px auto;max-width:1100px;padding:0 24px;color:#182230}svg{width:100%;font:12px system-ui}table{border-collapse:collapse;width:100%;font-size:13px}td,th{padding:9px;text-align:right;border-bottom:1px solid #ddd}td:first-child,th:first-child{text-align:left}p{line-height:1.7}</style>'+
  '<h1>Typst 编译次数与内存曲线</h1><p>原生 NodeCompiler + evictCache(30) + WASM renderer。每个场景使用独立主进程，所有试验顺序执行。两条同色曲线表示两次重复。RSS 为 Node 主进程与 Typst 子进程合计；子进程阶段上报可能漏掉瞬时峰值。</p>'+
  '<h2>短笔记：4096 次编译与第一页渲染</h2>'+chart('short')+
  '<h2>422 行笔记：2048 次编译与第一页渲染</h2>'+chart('note')+table+
  '<p>连续循环压力测试不等于真实保存频率。机器负载、GC 和分配器保留会影响耗时与 RSS；取值应同时考虑文档大小和冷启动频率。</p>';
await writeFile(new URL('curves.html',directory), html);
await writeFile(new URL('short.svg',directory),chart('short'));
await writeFile(new URL('note.svg',directory),chart('note'));
