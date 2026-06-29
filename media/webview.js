(function () {
  const vscode = acquireVsCodeApi();
  const payloadElement = document.getElementById('payload');
  const payload = payloadElement ? JSON.parse(payloadElement.getAttribute('data-json') || '{}') : {};
  const app = document.getElementById('app');

  function esc(value) {
    return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function help(text) {
    return text ? '<span class="help" tabindex="0" data-help="' + esc(text) + '">?</span>' : '';
  }

  function flatten(fields, depth, rows) {
    fields.forEach(function (field) {
      rows.push({ field: field, depth: depth });
      if (field.children) flatten(field.children, depth + 1, rows);
    });
    return rows;
  }

  function diagnostics(items) {
    if (!items || !items.length) return '';
    return items.map(function (diag) {
      var cls = diag.severity === 'error' ? 'err' : diag.severity === 'warning' ? 'warn' : 'info';
      return '<div class="banner ' + cls + '"><strong>' + esc(diag.severity.toUpperCase()) + '</strong>: ' + esc(diag.message) + (diag.path ? ' <span class="mono">' + esc(diag.path) + '</span>' : '') + '</div>';
    }).join('');
  }

  function render() {
    if (!payload.selected) {
      app.innerHTML = '<header><h1>Custom Binary Viewer</h1></header>' + diagnostics(payload.registryDiagnostics) + '<div class="banner warn">No matching format definitions were found.</div>';
      return;
    }
    var options = payload.candidates.map(function (candidate) {
      return '<option value="' + esc(candidate.id) + '"' + (candidate.id === payload.selectedId ? ' selected' : '') + '>' + esc(candidate.name) + ' (' + esc(candidate.score) + ')</option>';
    }).join('');
    var rows = flatten(payload.selected.result.fields, 0, []).map(function (row) {
      var field = row.field;
      var depth = Math.max(0, Math.min(16, row.depth));
      return '<tr><td class="mono">0x' + field.offset.toString(16).toUpperCase() + '</td><td class="mono">' + esc(field.length) + '</td><td><span class="tree-pad depth-' + depth + '"></span>' + esc(field.label) + help(field.description) + '</td><td class="mono">' + esc(field.type) + '</td><td class="value">' + esc(field.displayValue) + '</td><td class="mono">' + esc(field.rawValue) + '</td></tr>';
    }).join('');
    app.innerHTML = '<header><div><h1>' + esc(payload.selected.name) + '</h1><div class="meta">Score ' + esc(payload.selected.score) + ' · ' + esc(payload.selected.reasons.join(', ')) + '</div></div><div class="controls"><label for="formatSelect">Parser</label><select id="formatSelect" data-action="selectFormat">' + options + '</select><button data-action="reload">Reload</button></div></header>' + diagnostics(payload.registryDiagnostics) + diagnostics(payload.selected.result.diagnostics) + '<table><thead><tr><th>Offset</th><th>Len</th><th>Name</th><th>Type</th><th>Value</th><th>Raw</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  app.addEventListener('change', function (event) {
    var target = event.target;
    if (target && target.dataset && target.dataset.action === 'selectFormat') vscode.postMessage({ command: 'selectFormat', formatId: target.value });
  });
  app.addEventListener('click', function (event) {
    var target = event.target;
    if (target && target.dataset && target.dataset.action === 'reload') vscode.postMessage({ command: 'reload' });
  });
  render();
}());
