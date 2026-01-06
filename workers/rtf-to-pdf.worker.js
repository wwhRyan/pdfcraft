/**
 * RTF to PDF Worker (via Pyodide + PyMuPDF)
 * Uses PyMuPDF's Story feature to render RTF content
 */

import { loadPyodide } from '/pymupdf-wasm/pyodide.js';

let pyodide = null;
let initPromise = null;

async function init() {
    if (pyodide) return pyodide;

    self.postMessage({ type: 'status', message: 'Loading Python environment...' });

    // Initialize Pyodide
    pyodide = await loadPyodide({
        indexURL: '/pymupdf-wasm/',
        fullStdLib: false
    });

    self.postMessage({ type: 'status', message: 'Installing dependencies...' });

    const install = async (url) => {
        await pyodide.loadPackage(url);
    };

    const basePath = '/pymupdf-wasm/';

    // Install PyMuPDF and dependencies
    await install(basePath + 'numpy-2.2.5-cp313-cp313-pyodide_2025_0_wasm32.whl');
    await install(basePath + 'pymupdf-1.26.3-cp313-none-pyodide_2025_0_wasm32.whl');

    self.postMessage({ type: 'status', message: 'Initializing converter script...' });

    // Define the Python conversion script
    // RTF is converted by extracting text and rendering to PDF
    pyodide.runPython(`
import pymupdf
import re

def strip_rtf(text):
    """Simple RTF to plain text converter"""
    # Remove RTF control words and groups
    text = re.sub(r'\\\\[a-z]+\\d* ?', '', text)
    text = re.sub(r'[{}]', '', text)
    text = re.sub(r'\\\\\\\\', '\\\\', text)
    text = re.sub(r"\\\\'([0-9a-fA-F]{2})", lambda m: chr(int(m.group(1), 16)), text)
    # Clean up extra whitespace
    text = re.sub(r'\\n+', '\\n', text)
    text = text.strip()
    return text

def convert_rtf_to_pdf(input_obj):
    # Convert JsProxy (Uint8Array) to bytes
    if hasattr(input_obj, "to_py"):
        input_bytes = bytes(input_obj.to_py())
    else:
        input_bytes = bytes(input_obj)
    
    # Decode RTF content
    try:
        rtf_text = input_bytes.decode('utf-8')
    except:
        rtf_text = input_bytes.decode('latin-1')
    
    # Extract plain text from RTF
    plain_text = strip_rtf(rtf_text)
    
    # Create PDF with the text content
    doc = pymupdf.open()
    
    # Page dimensions (A4)
    page_width = 595
    page_height = 842
    margin = 72  # 1 inch margin
    
    # Font settings
    fontsize = 11
    lineheight = fontsize * 1.5
    
    # Split text into lines
    lines = plain_text.split('\\n')
    
    # Calculate available area
    text_width = page_width - 2 * margin
    max_lines_per_page = int((page_height - 2 * margin) / lineheight)
    
    current_line = 0
    page = None
    y_position = 0
    
    for line in lines:
        if page is None or current_line >= max_lines_per_page:
            page = doc.new_page(width=page_width, height=page_height)
            current_line = 0
            y_position = margin
        
        # Insert text
        if line.strip():
            page.insert_text(
                (margin, y_position + fontsize),
                line,
                fontsize=fontsize,
                fontname="helv"
            )
        
        y_position += lineheight
        current_line += 1
    
    # If no content, create at least one page
    if len(doc) == 0:
        doc.new_page(width=page_width, height=page_height)
    
    # Save to bytes
    pdf_bytes = doc.tobytes()
    doc.close()
    
    return pdf_bytes
  `);

    return pyodide;
}

self.onmessage = async (event) => {
    const { type, id, data } = event.data;

    try {
        if (type === 'init') {
            if (!initPromise) initPromise = init();
            await initPromise;
            self.postMessage({ id, type: 'init-complete' });
            return;
        }

        if (type === 'convert') {
            if (!pyodide) {
                if (!initPromise) initPromise = init();
                await initPromise;
            }

            const { file } = data;
            const arrayBuffer = await file.arrayBuffer();
            const inputBytes = new Uint8Array(arrayBuffer);

            self.postMessage({ type: 'status', message: 'Converting RTF to PDF...' });

            // Call Python function
            const convertFunc = pyodide.globals.get('convert_rtf_to_pdf');
            const resultProxy = convertFunc(inputBytes);
            const resultBytes = resultProxy.toJs();
            resultProxy.destroy();

            const resultBlob = new Blob([resultBytes], { type: 'application/pdf' });

            self.postMessage({
                id,
                type: 'convert-complete',
                result: resultBlob
            });
        }

    } catch (error) {
        console.error('Worker error:', error);
        self.postMessage({
            id,
            type: 'error',
            error: error.message || String(error)
        });
    }
};
