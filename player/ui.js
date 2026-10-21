// The buffering spinner overlay, idempotent per cell.
export function showSpinner(cell) {
    if (!cell || cell.querySelector('.mv-loading')) return;
    const s = document.createElement('div');
    s.className = 'mv-loading';
    s.innerHTML = '<div class="mv-spinner"></div>';
    cell.appendChild(s);
}
export function hideSpinner(cell) {
    cell?.querySelector('.mv-loading')?.remove();
}
// m:ss, or h:mm:ss past an hour.
export function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    const total = Math.floor(s);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(sec).padStart(2, '0');
}
