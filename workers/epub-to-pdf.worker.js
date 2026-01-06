/**
 * EPUB to PDF Worker (via Pyodide + PyMuPDF)
 * PyMuPDF has native EPUB support, providing high-quality conversion!
 * 
 * Balanced between quality and memory usage
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
    await install(basePath + 'pymupdf-1.26.3-cp313-none-pyodide_2025_0_wasm32.whl');

    // Download CJK Font for international text support
    self.postMessage({ type: 'status', message: 'Downloading fonts...' });
    try {
        const response = await fetch('https://raw.githack.com/googlefonts/noto-cjk/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf');
        if (response.ok) {
            const fontData = await response.arrayBuffer();
            pyodide.FS.writeFile('custom_font.otf', new Uint8Array(fontData));
        }
    } catch (e) {
        console.warn('Font download error:', e);
    }

    self.postMessage({ type: 'status', message: 'Initializing converter...' });

    pyodide.runPython(`
import pymupdf
import os
import gc

def convert_epub_to_pdf(input_obj, quality='medium', page_width=595, page_height=842):
    """
    Convert EPUB to PDF using PyMuPDF's native EPUB support.
    Balanced for quality and memory usage in WASM environment.
    """
    if hasattr(input_obj, "to_py"):
        input_bytes = bytes(input_obj.to_py())
    else:
        input_bytes = bytes(input_obj)
    
    # Quality configuration - balanced for clarity and memory
    # Higher scale = sharper text, more memory
    quality_config = {
        'low': {'scale': 1.0, 'max_dim': 1500, 'use_jpeg': True, 'jpeg_quality': 80},
        'medium': {'scale': 1.5, 'max_dim': 2000, 'use_jpeg': True, 'jpeg_quality': 90},
        'high': {'scale': 2.0, 'max_dim': 2500, 'use_jpeg': False, 'jpeg_quality': 95}  # PNG for high
    }
    config = quality_config.get(quality, quality_config['medium'])
    quality_scale = config['scale']
    max_dim = config['max_dim']
    use_jpeg = config['use_jpeg']
    jpeg_quality = config['jpeg_quality']
    
    # Open EPUB with PyMuPDF
    epub_doc = pymupdf.open(stream=input_bytes, filetype="epub")
    
    # Create output PDF
    pdf_doc = pymupdf.open()
    
    margin = 30
    target_width = page_width - 2 * margin
    target_height = page_height - 2 * margin
    
    total_pages = len(epub_doc)
    
    # Convert each page
    for page_num in range(total_pages):
        epub_page = epub_doc[page_num]
        rect = epub_page.rect
        
        if rect.width <= 0 or rect.height <= 0:
            continue
        
        # Calculate render scale with pixel limit
        base_scale = min(max_dim / rect.width, max_dim / rect.height, quality_scale)
        
        # Render to pixmap
        mat = pymupdf.Matrix(base_scale, base_scale)
        pix = epub_page.get_pixmap(matrix=mat, alpha=False)
        
        # Convert to image bytes
        if use_jpeg:
            img_bytes = pix.tobytes("jpeg", jpg_quality=jpeg_quality)
        else:
            img_bytes = pix.tobytes("png")
        
        # Store dimensions before freeing
        pix_width = pix.width
        pix_height = pix.height
        pix = None
        gc.collect()
        
        # Create PDF page
        pdf_page = pdf_doc.new_page(width=page_width, height=page_height)
        
        # Calculate display size to fit in target area
        scale_to_fit_w = target_width / pix_width if pix_width > target_width else 1.0
        scale_to_fit_h = target_height / pix_height if pix_height > target_height else 1.0
        scale_to_fit = min(scale_to_fit_w, scale_to_fit_h)
        
        display_width = pix_width * scale_to_fit
        display_height = pix_height * scale_to_fit
        
        # Center on page
        x_offset = (page_width - display_width) / 2
        y_offset = (page_height - display_height) / 2
        
        insert_rect = pymupdf.Rect(x_offset, y_offset, x_offset + display_width, y_offset + display_height)
        
        # Insert image
        pdf_page.insert_image(insert_rect, stream=img_bytes)
        
        # Free memory
        img_bytes = None
        gc.collect()
        
        # Periodic garbage collection
        if page_num % 5 == 4:
            gc.collect()
    
    epub_doc.close()
    gc.collect()
    
    # Save with compression
    pdf_bytes = pdf_doc.tobytes(garbage=4, deflate=True)
    pdf_doc.close()
    
    gc.collect()
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

            const { file, quality = 'medium' } = data;
            const arrayBuffer = await file.arrayBuffer();
            const inputBytes = new Uint8Array(arrayBuffer);

            self.postMessage({ type: 'status', message: 'Converting EPUB to PDF...' });

            const convertFunc = pyodide.globals.get('convert_epub_to_pdf');
            const resultProxy = convertFunc(inputBytes, quality);
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
