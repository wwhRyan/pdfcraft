/**
 * PowerPoint to PDF Worker (via Pyodide + PyMuPDF)
 * Improvements:
 * 1. Downloads and uses Noto Sans CJK for international text support
 * 2. Parsers relationships to extract and render images
 * 3. Improves text extraction from shapes
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
        // Use a smaller font if possible, but for CJK we need a large one.
        // Using the URL from text-to-pdf.ts. Note: This is ~16MB.
        const response = await fetch('https://raw.githack.com/googlefonts/noto-cjk/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf');
        if (response.ok) {
            const fontData = await response.arrayBuffer();
            pyodide.FS.writeFile('custom_font.otf', new Uint8Array(fontData));
        } else {
            console.warn('Font download failed, falling back to Helvetica');
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

def convert_pptx_to_pdf(input_obj):
    if hasattr(input_obj, "to_py"):
        input_bytes = bytes(input_obj.to_py())
    else:
        input_bytes = bytes(input_obj)
    
    try:
        pptx_zip = zipfile.ZipFile(io.BytesIO(input_bytes), 'r')
    except zipfile.BadZipFile:
        raise ValueError("Invalid PPTX file")
    
    pdf = pymupdf.open()
    
    # Page setup
    page_width = 842
    page_height = 595
    margin = 40
    
    # Check for custom font
    font_file = None
    font_name = "helv"
    if os.path.exists('custom_font.otf'):
        font_file = 'custom_font.otf'
        font_name = "custom"
    
    # Namespaces
    ns = {
        'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
        'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
        'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    }
    
    def get_slide_files():
        files = []
        for name in pptx_zip.namelist():
            if name.startswith('ppt/slides/slide') and name.endswith('.xml'):
                match = re.search(r'slide(\\d+)\\.xml$', name)
                if match:
                    files.append((int(match.group(1)), name))
        files.sort(key=lambda x: x[0])
        return files

    def get_relationships(slide_filename):
        # ppt/slides/slide1.xml -> ppt/slides/_rels/slide1.xml.rels
        dirname = os.path.dirname(slide_filename)
        basename = os.path.basename(slide_filename)
        rels_path = f"{dirname}/_rels/{basename}.rels"
        
        rels = {}
        if rels_path in pptx_zip.namelist():
            try:
                content = pptx_zip.read(rels_path)
                root = etree.fromstring(content)
                for rel in root.iter('{http://schemas.openxmlformats.org/package/2006/relationships}Relationship'):
                    rid = rel.get('Id')
                    target = rel.get('Target')
                    # Resolve relative path
                    # Target is usually like "../media/image1.png"
                    # Base is "ppt/slides/"
                    # Resolved: "ppt/media/image1.png"
                    if target.startswith('../'):
                        target = 'ppt/' + target[3:]
                    rels[rid] = target
            except Exception as e:
                print(f"Error parsing rels: {e}")
        return rels

    def parser_color(color_elem):
        # Basic color mapping - placeholder
        return (0, 0, 0)

    # EMU to Point conversion (1 inch = 914400 EMUs, 72 pt = 1 inch)
    def emu_to_pt(emu):
        if emu is None: return 0
        return int(emu) / 12700

    slide_files = get_slide_files()
    
    for slide_idx, (slide_num, slide_path) in enumerate(slide_files):
        page = pdf.new_page(width=page_width, height=page_height)
        
        # Draw slide number
        page.insert_text(
            (page_width - margin - 30, page_height - 20),
            f"{slide_idx + 1}",
            fontsize=10,
            fontname=font_name,
            fontfile=font_file,
            color=(0.5, 0.5, 0.5)
        )
        
        relationships = get_relationships(slide_path)
        
        try:
            content = pptx_zip.read(slide_path)
            root = etree.fromstring(content)
            
            # Use simple y-flow for text if no strict layout
            flow_y = margin
            
            # Iterate over Shape Tree
            spTree = root.find('.//p:spTree', ns)
            if spTree is not None:
                for child in spTree:
                    tag = child.tag
                    
                    # 1. Pictures <p:pic>
                    if tag.endswith('pic'):
                        try:
                            blip = child.find('.//a:blip', ns)
                            if blip is not None:
                                embed_id = blip.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed')
                                if embed_id and embed_id in relationships:
                                    img_path = relationships[embed_id]
                                    if img_path in pptx_zip.namelist():
                                        img_data = pptx_zip.read(img_path)
                                        
                                        # Get transformation
                                        xfrm = child.find('.//a:xfrm', ns)
                                        off = xfrm.find('a:off', ns)
                                        ext = xfrm.find('a:ext', ns)
                                        
                                        x = emu_to_pt(off.get('x'))
                                        y = emu_to_pt(off.get('y'))
                                        w = emu_to_pt(ext.get('cx'))
                                        h = emu_to_pt(ext.get('cy'))
                                        
                                        # Simple bounds check/scaling to page
                                        scale = 1.0
                                        # (Complex layout logic omitted for brevity, just insert)
                                        # If coordinates are very large or negative, we might clamp or ignore
                                        # For now, let's try to map typical slide size (9144000 EMUs width) to PDF width
                                        # If x,y seem reasonable (within slide), use them.
                                        # Note: Default slide size is often 10x7.5 inches or 13.33x7.5
                                        
                                        # Scale coordinates to fit our PDF page
                                        # Assuming standard 16:9 slide (10" wide) -> our 842pt page
                                        # 10 inches = 720 pt. 842pt is ~A4 landscape.
                                        # Let's map directly for now, assuming standard sizes.
                                        
                                        # Many PPTX use a coordinate system that matches points roughly if converted
                                        # But let's apply a scaling factor if needed.
                                        
                                        rect = pymupdf.Rect(x, y, x + w, y + h)
                                        
                                        # Clip to page roughly
                                        if rect.width > 0 and rect.height > 0:
                                           page.insert_image(rect, stream=img_data)
                        except Exception as e:
                            print(f"Error parse pic: {e}")
                    
                    # 2. Text Shapes <p:sp>
                    elif tag.endswith('sp'):
                        # Check for text
                        txBody = child.find('p:txBody', ns)
                        if txBody is not None:
                            text_content = []
                            for p in txBody.iter('{http://schemas.openxmlformats.org/drawingml/2006/main}p'):
                                p_text = ""
                                for t in p.iter('{http://schemas.openxmlformats.org/drawingml/2006/main}t'):
                                    if t.text:
                                        p_text += t.text
                                if p_text:
                                    text_content.append(p_text)
                            
                            if text_content:
                                # Try to get position (xfrm)
                                spPr = child.find('p:spPr', ns)
                                x = margin
                                y = flow_y
                                w = page_width - 2*margin
                                fontsize = 14
                                
                                has_coords = False
                                if spPr is not None:
                                    xfrm = spPr.find('a:xfrm', ns)
                                    if xfrm is not None:
                                        off = xfrm.find('a:off', ns)
                                        if off is not None:
                                            x = emu_to_pt(off.get('x'))
                                            y = emu_to_pt(off.get('y'))
                                            has_coords = True
                                        
                                # Render text
                                for line in text_content:
                                    # Very basic text insertion
                                    # If we have coords, use textwriter or textbox
                                    if has_coords:
                                        # Use text box to auto-wrap
                                        rect = pymupdf.Rect(x, y, x + 500, y + 500) # Arbitrary width
                                        
                                        # Heuristic for title vs body
                                        if y < 100: fontsize = 24
                                        else: fontsize = 14
                                        
                                        page.insert_textbox(rect, line, fontsize=fontsize, fontname=font_name, fontfile=font_file)
                                        y += fontsize * 1.5
                                    else:
                                        # Fallback flow
                                        page.insert_text((margin, flow_y), line, fontsize=12, fontname=font_name, fontfile=font_file)
                                        flow_y += 18
                                        
        except Exception as e:
            page.insert_text((margin, margin), f"Error: {e}", color=(1,0,0))

    if len(pdf) == 0:
        pdf.new_page()
    
    pptx_zip.close()
    return pdf.tobytes()
    `);

    return pyodide;
}

self.onmessage = async (event) => {
    // ... (standard message handling same as before)
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
            self.postMessage({ type: 'status', message: 'Converting PowerPoint to PDF...' });

            const convertFunc = pyodide.globals.get('convert_pptx_to_pdf');
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
