/**
 * Admin Tables On Phones
 * Under 768px every admin table becomes a stack of cards: one card per row, each cell
 * labelled with its column heading (the dark mode colours live in dark.css under
 * .responsive-table). Tables keep their normal layout from 768px up. Rows are rendered
 * by each page's own script, so a MutationObserver labels new cells as they arrive.
 * Skip a table with data-no-stack. Add data-compact for smaller cards (two fields per line).
 */
(function () {
    // --- 1. Card Styles (phones only) ---
    var css = [
        '@media (max-width: 767px) {',
        '  .responsive-table { min-width: 0 !important; width: 100% !important; border-collapse: separate; }',
        '  .responsive-table thead { display: none; }',
        '  .responsive-table, .responsive-table tbody { display: block; }',
        '  .responsive-table tbody { padding: 12px; }',
        '  .responsive-table tr { display: block; background: #FFFFFF; border: 1px solid #EAECF0; border-radius: 16px; padding: 4px 14px; margin-bottom: 12px; box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04); }',
        '  .responsive-table tr:last-child { margin-bottom: 0; }',
        // Label in the left column; everything the cell holds stacks in the right column
        '  .responsive-table td { display: grid; grid-template-columns: minmax(0, 38%) minmax(0, 1fr); column-gap: 12px; row-gap: 0; align-items: center; justify-items: end; padding: 10px 0 !important; border-bottom: 1px solid #F2F4F7; text-align: right !important; white-space: normal !important; min-width: 0; max-width: none !important; width: auto !important; word-break: break-word; }',
        '  .responsive-table td:last-child { border-bottom: none; }',
        '  .responsive-table td > * { grid-column: 2; min-width: 0; max-width: 100%; }',
        '  .responsive-table td::before { content: attr(data-label); grid-column: 1; grid-row: 1 / span 20; justify-self: start; align-self: start; text-align: left; font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #667085; padding-top: 3px; }',
        '  .responsive-table td[data-label=""] { grid-template-columns: minmax(0, 1fr); }',
        '  .responsive-table td[data-label=""]::before { display: none; }',
        '  .responsive-table td[data-label=""] > * { grid-column: 1; }',
        // Several action buttons sit side by side instead of stacking
        '  .responsive-table td:has(> button ~ button), .responsive-table td:has(> a ~ button), .responsive-table td:has(> button ~ a) { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px 14px; }',
        '  .responsive-table td:has(> button ~ button)::before, .responsive-table td:has(> a ~ button)::before, .responsive-table td:has(> button ~ a)::before { margin-right: auto; padding-top: 0; }',
        // Empty / loading rows (one cell spanning the table) stay a plain centred message
        '  .responsive-table td[colspan] { display: block; text-align: center !important; border-bottom: none; }',
        '  .responsive-table td[colspan]::before { display: none; }',
        '  .responsive-table tr:has(> td[colspan]:only-child) { border: none; background: transparent; box-shadow: none; }',
        // Compact cards (opt in with data-compact): two fields per line, label above value, nothing hidden
        '  .responsive-table[data-compact] tbody { padding: 10px; }',
        '  .responsive-table[data-compact] tr { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); column-gap: 14px; padding: 10px 12px; margin-bottom: 10px; border-radius: 14px; }',
        '  .responsive-table[data-compact] td { display: block; padding: 5px 0 !important; border-bottom: none; text-align: left !important; justify-items: start; font-size: 12px; line-height: 1.35; }',
        '  .responsive-table[data-compact] td > * { max-width: 100%; }',
        '  .responsive-table[data-compact] td::before { display: block; padding: 0 0 1px; font-size: 9px; }',
        '  .responsive-table[data-compact] td[colspan] { grid-column: 1 / -1; text-align: center !important; }',
        '}'
    ].join('\n');
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    // --- 2. Label Each Cell With Its Column Heading ---
    function headings(table) {
        var labels = [];
        var cells = table.querySelectorAll('thead tr:last-child th, thead tr:last-child td');
        Array.prototype.forEach.call(cells, function (th) {
            var span = parseInt(th.getAttribute('colspan'), 10) || 1;
            for (var i = 0; i < span; i++) labels.push(th.textContent.trim());
        });
        return labels;
    }

    function labelRows(table, labels) {
        Array.prototype.forEach.call(table.querySelectorAll('tbody tr'), function (row) {
            var col = 0;
            Array.prototype.forEach.call(row.children, function (cell) {
                if (!cell.hasAttribute('data-label')) cell.setAttribute('data-label', labels[col] || '');
                col += parseInt(cell.getAttribute('colspan'), 10) || 1;
            });
        });
    }

    function setup(table) {
        if (table.dataset.noStack !== undefined || table.dataset.stacked) return;
        var labels = headings(table);
        if (!labels.length) return;
        table.dataset.stacked = '1';
        table.classList.add('responsive-table');
        labelRows(table, labels);
        // Headings are read again each time, since some pages swap them (Transaction History tabs)
        new MutationObserver(function () { labelRows(table, headings(table)); })
            .observe(table, { childList: true, subtree: true });
    }

    // --- 3. Every Table In The Page, Including Ones Added Later ---
    function scan() {
        Array.prototype.forEach.call(document.querySelectorAll('main table'), setup);
    }

    document.addEventListener('DOMContentLoaded', function () {
        scan();
        new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
    });
})();
