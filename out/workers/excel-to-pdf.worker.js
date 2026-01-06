/**
 * Excel to PDF Worker (via Pyodide + PyMuPDF)
 * Improvements:
 * 1. Downloads and uses Noto Sans CJK for international text support
 * 2. Optimized direct ZIP parsing
 */

import { loadPyodide } from '/pymupdf-wasm/pyodide.js';

let pyodide = null;
let initPromise = null;

async function init() {
    if (pyodide) return pyodide;

    self.postMessage({ type: 'status', message: 'Loading Python environment...' });

    pyodide = await loadPyodide({
        indexURL: '/pymupdf-wasm/',
        fullStdLib: false
    });

    self.postMessage({ type: 'status', message: 'Installing dependencies...' });

    const install = async (url) => {
        await pyodide.loadPackage(url);
    };

    const basePath = '/pymupdf-wasm/';
    await install(basePath + 'numpy-2.2.5-cp313-cp313-pyodide_2025_0_wasm32.whl');
    await install(basePath + 'lxml-5.4.0-cp313-cp313-pyodide_2025_0_wasm32.whl');
    await install(basePath + 'pymupdf-1.26.3-cp313-none-pyodide_2025_0_wasm32.whl');

    // Download Font
    self.postMessage({ type: 'status', message: 'Downloading fonts...' });
    try {
        const response = await fetch('https://raw.githack.com/googlefonts/noto-cjk/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf');
        if (response.ok) {
            const fontData = await response.arrayBuffer();
            pyodide.FS.writeFile('custom_font.otf', new Uint8Array(fontData));
        } else {
            console.warn('Font download failed, using fallback');
        }
    } catch (e) {
        console.warn('Font download error:', e);
    }

    self.postMessage({ type: 'status', message: 'Initializing converter...' });

    pyodide.runPython(`
import pymupdf
import zipfile
import io
import re
import os
from lxml import etree

def convert_excel_to_pdf(input_obj):
    if hasattr(input_obj, "to_py"):
        input_bytes = bytes(input_obj.to_py())
    else:
        input_bytes = bytes(input_obj)
    
    try:
        xlsx_zip = zipfile.ZipFile(io.BytesIO(input_bytes), 'r')
    except zipfile.BadZipFile:
        raise ValueError("Invalid XLSX file")
    
    pdf = pymupdf.open()
    
    # Page dimensions (A4 Landscape)
    page_width = 842
    page_height = 595
    margin = 40
    
    # Font setup
    font_file = None
    font_name = "helv"
    if os.path.exists('custom_font.otf'):
        font_file = 'custom_font.otf'
        font_name = "custom"
    
    fontsize = 9
    cell_padding = 4
    row_height = fontsize + cell_padding * 2
    
    # Read shared strings
    shared_strings = []
    if 'xl/sharedStrings.xml' in xlsx_zip.namelist():
        try:
            content = xlsx_zip.read('xl/sharedStrings.xml')
            root = etree.fromstring(content)
            for si in root.iter('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}si'):
                text_parts = []
                for t in si.iter('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t'):
                    if t.text:
                        text_parts.append(t.text)
                shared_strings.append(''.join(text_parts))
        except Exception: pass
    
    # Get sheets
    sheet_files = []
    for name in xlsx_zip.namelist():
        if name.startswith('xl/worksheets/sheet') and name.endswith('.xml'):
            match = re.search(r'sheet(\\d+)\\.xml$', name)
            if match:
                sheet_files.append((int(match.group(1)), name))
    sheet_files.sort(key=lambda x: x[0])
    
    for sheet_idx, (sheet_num, sheet_path) in enumerate(sheet_files):
        page = pdf.new_page(width=page_width, height=page_height)
        
        # Header
        try:
            # Need to find sheet name? Usually in xl/workbook.xml. Skipping for brevity, using Sheet X
            sheet_title = f"Sheet {sheet_idx + 1}"
            
            page.insert_text(
                (margin, margin),
                sheet_title,
                fontsize=12,
                fontname=font_name,
                fontfile=font_file
            )
            
            y_position = margin + 20
            max_y = page_height - margin
            
            content = xlsx_zip.read(sheet_path)
            root = etree.fromstring(content)
            
            rows = []
            for row in root.iter('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}row'):
                r_cells = []
                for c in row.iter('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}c'):
                    val = ""
                    t_attr = c.get('t')
                    v_node = c.find('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}v')
                    if v_node is not None and v_node.text:
                        if t_attr == 's':
                            try:
                                idx = int(v_node.text)
                                if idx < len(shared_strings):
                                    val = shared_strings[idx]
                            except: val = v_node.text
                        else:
                            val = v_node.text
                    else:
                        # Inline string
                        is_node = c.find('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}is')
                        if is_node is not None:
                            parts = []
                            for t in is_node.iter('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t'):
                                if t.text: parts.append(t.text)
                            val = "".join(parts)
                    r_cells.append(val)
                if any(r_cells):
                    rows.append(r_cells)
            
            if rows:
                col_count = max(len(r) for r in rows)
                # Calculate widths based on content length
                col_widths = [0] * col_count
                for r in rows[:50]: # Sample
                    for i, cell in enumerate(r):
                        if i < col_count:
                            # Rudimentary width calc: char count * font factor
                            # Double width for non-ascii characters (CJK)
                            w = 0
                            for char in str(cell):
                                w += 10 if ord(char) > 255 else 5
                            col_widths[i] = max(col_widths[i], w)
                
                # Normalize widths
                col_widths = [max(min(w, 200), 40) for w in col_widths]
                
                # Render
                for row_data in rows:
                    if y_position + row_height > max_y:
                        page = pdf.new_page(width=page_width, height=page_height)
                        y_position = margin
                    
                    x = margin
                    for i, cell_text in enumerate(row_data):
                        if i >= len(col_widths): break
                        w = col_widths[i]
                        
                        if cell_text:
                            # Draw cell border? Optional. 
                            # page.draw_rect((x, y_position, x+w, y_position+row_height), width=0.5, color=(0.8,0.8,0.8))
                            
                            page.insert_textbox(
                                (x + 2, y_position + 2, x + w - 2, y_position + row_height - 1),
                                str(cell_text),
                                fontsize=fontsize,
                                fontname=font_name,
                                fontfile=font_file,
                                align=0 
                            )
                        x += w
                    y_position += row_height
                    
        except Exception as e:
            page.insert_text((margin, y_position), f"Error: {e}", color=(1,0,0))

    if len(pdf) == 0:
        pdf.new_page()
        
    xlsx_zip.close()
    return pdf.tobytes()
    `);

    return pyodide;
}

self.onmessage = async (event) => {
    // Standard handler
    const { type, id, data } = event.data;
    try {
        if (type === 'init') {
            if (!initPromise) initPromise = init();
            await initPromise;
            self.postMessage({ id, type: 'init-complete' });
            return;
        }
        if (type === 'convert') {
            if (!pyodide) { if (!initPromise) initPromise = init(); await initPromise; }
            const { file } = data;
            const arrayBuffer = await file.arrayBuffer();
            const inputBytes = new Uint8Array(arrayBuffer);
            self.postMessage({ type: 'status', message: 'Converting Excel to PDF...' });

            const convertFunc = pyodide.globals.get('convert_excel_to_pdf');
            const resultProxy = convertFunc(inputBytes);
            const resultBytes = resultProxy.toJs();
            resultProxy.destroy();

            const resultBlob = new Blob([resultBytes], { type: 'application/pdf' });
            self.postMessage({ id, type: 'convert-complete', result: resultBlob });
        }
    } catch (error) {
        console.error('Worker error:', error);
        self.postMessage({ id, type: 'error', error: error.message || String(error) });
    }
};
