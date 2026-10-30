"""Retrieve pinned evidence, inventory every raster placement, and render review sheets.

No image is admitted to the benchmark automatically. Text, source filenames and
page renders remain private review evidence, never model inputs.
"""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import html
import io
import re
from urllib.parse import urljoin

import pymupdf as pdf
import requests
from PIL import Image

from common import LOCAL, ROOT, catalogue, digest, read_json, write_json, write_jsonl


def retrieve(url):
    response = requests.get(url, timeout=(15, 60), headers={'User-Agent': 'PropertyStateBenchmark/0.1 (local research)'})
    response.raise_for_status()
    return response.content


def rgb_pixmap(pix):
    if pix.colorspace and pix.colorspace.n != 3:
        pix = pdf.Pixmap(pdf.csRGB, pix)
    if pix.alpha:
        # Composite transparency against white, rather than discarding its mask.
        document = pdf.open()
        page = document.new_page(width=pix.width, height=pix.height)
        page.insert_image(page.rect, pixmap=pix)
        pix = page.get_pixmap(alpha=False)
        document.close()
    return pix


def difference_hash(pix):
    small = pdf.Pixmap(pix, 9, 8)
    small = pdf.Pixmap(pdf.csGRAY, small)
    values = small.samples
    result = 0
    for y in range(8):
        for x in range(8):
            result = (result << 1) | (values[y * 9 + x] > values[y * 9 + x + 1])
    return f'{result:016x}'


def save_asset(pix):
    pix = rgb_pixmap(pix)
    pixel_hash = digest(f'{pix.width}x{pix.height}:RGB:'.encode() + pix.samples)
    asset_id = 'a_' + pixel_hash[:20]
    destination = LOCAL / 'assets' / f'{asset_id}.png'
    destination.parent.mkdir(parents=True, exist_ok=True)
    encoded = pix.tobytes('png')
    if not destination.exists():
        destination.write_bytes(encoded)
    return {'asset_id': asset_id, 'path': str(destination.relative_to(LOCAL)).replace('\\', '/'),
            'width': pix.width, 'height': pix.height, 'pixel_sha256': pixel_hash,
            'file_sha256': digest(encoded), 'dhash': difference_hash(pix),
            'quality': 'low_resolution' if min(pix.width, pix.height) < 256 else 'standard_resolution'}


def extract_pdf(source, data):
    document = pdf.open(stream=data, filetype='pdf')
    all_images = [page.get_image_info(xrefs=True) for page in document]
    repetition = Counter(i['digest'].hex() for images in all_images for i in images)
    assets, placements, pages = {}, [], []
    for page, images in zip(document, all_images):
        pno = page.number + 1
        page_record = {'page': pno, 'width': page.rect.width, 'height': page.rect.height,
                       'text_blocks': [{'bbox': list(b[:4]), 'text': b[4]} for b in page.get_text('blocks') if b[6] == 0]}
        pages.append(page_record)
        masks = {entry[0]: entry[1] for entry in page.get_images(full=True)}
        for index, image in enumerate(images, 1):
            box = pdf.Rect(image['bbox'])
            key = f"{source['id']}:p{pno:03d}:i{index:02d}"
            flags = []
            if pno == 1:
                flags.append('cover_requires_review')
            if box.y1 <= 80 or box.y0 >= page.rect.height - 65:
                flags.append('header_or_footer')
            if min(image['width'], image['height']) < 80:
                flags.append('small_graphic')
            if repetition[image['digest'].hex()] >= 4:
                flags.append('repeated_graphic_requires_review')
            try:
                if image['xref']:
                    pix = pdf.Pixmap(document, image['xref'])
                    if masks.get(image['xref']):
                        if pix.alpha:
                            pix = pdf.Pixmap(pix, 0)
                        pix = pdf.Pixmap(pix, pdf.Pixmap(document, masks[image['xref']]))
                    method = 'native_image'
                else:
                    pix = page.get_pixmap(matrix=pdf.Matrix(2, 2), clip=box, alpha=False)
                    method = 'page_crop_144dpi'
                asset = save_asset(pix)
                assets[asset['asset_id']] = asset
                placements.append({'placement_id': key, 'source_id': source['id'], 'page': pno,
                                   'image_index': index, 'bbox': list(box), 'xref': image['xref'],
                                   'asset_id': asset['asset_id'], 'method': method, 'flags': flags,
                                   'status': 'excluded_graphic' if any(f in flags for f in ['header_or_footer', 'small_graphic']) else 'pending_visual_review'})
            except Exception as error:
                placements.append({'placement_id': key, 'source_id': source['id'], 'page': pno,
                                   'image_index': index, 'bbox': list(box), 'status': 'extraction_failed', 'error': str(error)})
    document.close()
    write_json(LOCAL / 'pages' / f"{source['id']}.json", pages)
    return list(assets.values()), placements, len(pages)


def process_source(source):
    result = {'source_id': source['id'], 'source_url': source['source_url'],
              'category': source['category'], 'reuse_status': source['reuse_status'],
              'checked_at_utc': datetime.now(timezone.utc).isoformat(), 'status': 'unavailable'}
    try:
        is_html = source['category'] == 'candidate_report_excerpt'
        raw = LOCAL / 'reports' / (source['id'] + ('.html' if is_html else '.pdf'))
        data = raw.read_bytes() if raw.exists() else retrieve(source['source_url'])
        # Once an initially inaccessible PDF has been retrieved and reviewed,
        # subsequent runs must honor its release lock as well.
        lock = read_json(ROOT / 'sources-lock.json') if (ROOT / 'sources-lock.json').exists() else {}
        expected = source['access_check'].get('sha256') or lock.get(source['id'], {}).get('sha256')
        result.update({'sha256': digest(data), 'catalogue_sha256': source['access_check'].get('sha256'), 'bytes': len(data)})
        # HTML is dynamic; PDFs must match the evidence reviewed in the catalogue.
        if not is_html and expected and digest(data) != expected:
            result['status'] = 'source_changed_requires_review'
            return result, [], []
        raw.parent.mkdir(parents=True, exist_ok=True)
        raw.write_bytes(data)
        if is_html:
            markup = data.decode('utf-8', errors='replace')
            # A report screenshot can contain mixed RGB/thermal images and text.
            # Inventory the known excerpt, but do not pretend it is a clean RGB photo.
            urls = set(source.get('supporting_urls', []))
            for value in re.findall(r'(?:src|data-src)=["\']([^"\']+)["\']', markup):
                if 'fotorapportage-pagina-8' in value:
                    urls.add(urljoin(source['source_url'], html.unescape(value)))
            excerpts = []
            for url in sorted(urls):
                try:
                    image_bytes = retrieve(url)
                    filename = digest(image_bytes)[:20] + '.image'
                    (LOCAL / 'reports' / filename).write_bytes(image_bytes)
                    with Image.open(io.BytesIO(image_bytes)) as image:
                        width, height = image.size
                    excerpts.append({'url': url, 'sha256': digest(image_bytes), 'width': width, 'height': height,
                                     'path': 'reports/' + filename, 'status': 'mixed_excerpt_requires_modality_and_pairing_review'})
                except Exception as error:
                    excerpts.append({'url': url, 'status': 'unavailable', 'error': str(error)})
            result.update({'status': 'excerpt_review_required', 'excerpts': excerpts,
                           'html_changed_since_catalogue': digest(data) != expected})
            return result, [], []
        assets, placements, pages = extract_pdf(source, data)
        result.update({'status': 'extracted', 'page_count': pages, 'placement_count': len(placements)})
        return result, assets, placements
    except Exception as error:
        result['error'] = str(error)
        return result, [], []


def run_extract():
    previous_lock = read_json(ROOT/'sources-lock.json') if (ROOT/'sources-lock.json').exists() else {}
    sources = [s for s in catalogue() if s['category'].startswith('candidate')]
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(process_source, sources))
    assets = {a['asset_id']: a for _, aa, _ in results for a in aa}
    placements = [p for _, _, pp in results for p in pp]
    manifest = {'schema_version': 1, 'sources': [r for r, _, _ in results],
                'assets': sorted(assets.values(), key=lambda a: a['asset_id']), 'placements': placements}
    write_json(LOCAL / 'extraction.json', manifest)
    write_jsonl(LOCAL / 'review-queue.jsonl', [p for p in placements if p['status'] != 'excluded_graphic'])
    # Stable access lock excludes volatile timestamps and complete report text.
    updated_lock = {}
    for result, _, _ in results:
        sid = result['source_id']
        previous = previous_lock.get(sid, {})
        # A failed/changed fetch cannot advance a previously reviewed PDF pin.
        if previous.get('status') == 'extracted' and result['status'] != 'extracted':
            updated_lock[sid] = previous
        else:
            updated_lock[sid] = {k: v for k, v in result.items() if k not in ['checked_at_utc', 'error']}
    write_json(ROOT / 'sources-lock.json', updated_lock)
    for result, _, _ in results:
        print(result['source_id'], result['status'], result.get('page_count', ''), result.get('error', ''))
    print(f'{len(assets)} unique raster assets; {len(placements)} placements; none automatically labeled.')


def render_sheet(manifest, source_id, page_numbers=None):
    assets = {a['asset_id']: a for a in manifest['assets']}
    placements = [p for p in manifest['placements'] if p['source_id'] == source_id and p.get('asset_id')
                  and p['status'] != 'excluded_graphic' and (not page_numbers or p['page'] in page_numbers)]
    output = LOCAL / 'review'
    output.mkdir(parents=True, exist_ok=True)
    paths = []
    for offset in range(0, len(placements), 12):
        subset = placements[offset:offset+12]
        sheet = pdf.open()
        page = sheet.new_page(width=1200, height=4*270)
        for i, placement in enumerate(subset):
            x, y = (i % 3)*400, (i//3)*270
            asset = assets[placement['asset_id']]
            page.insert_text((x+8, y+17), placement['placement_id'], fontsize=10)
            page.insert_text((x+8, y+31), f"{asset['width']} x {asset['height']} | {placement['method']}", fontsize=8)
            page.insert_image(pdf.Rect(x+8, y+38, x+392, y+260), filename=str(LOCAL / asset['path']), keep_proportion=True)
        path = output / f'{source_id}-{offset//12+1:02d}.png'
        page.get_pixmap().save(path)
        sheet.close()
        paths.append(str(path))
    return paths


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('extract')
    sheet = sub.add_parser('sheets')
    sheet.add_argument('source_id')
    sheet.add_argument('--pages', type=int, nargs='+')
    render = sub.add_parser('page')
    render.add_argument('source_id')
    render.add_argument('page', type=int)
    args = parser.parse_args()
    if args.command == 'extract':
        run_extract()
    elif args.command == 'sheets':
        for path in render_sheet(read_json(LOCAL / 'extraction.json'), args.source_id, args.pages):
            print(path)
    else:
        with pdf.open(LOCAL / 'reports' / (args.source_id + '.pdf')) as doc:
            destination = LOCAL / 'review' / f'{args.source_id}-page-{args.page}.png'
            destination.parent.mkdir(parents=True, exist_ok=True)
            doc[args.page-1].get_pixmap(matrix=pdf.Matrix(1.4, 1.4)).save(destination)
            print(destination)


if __name__ == '__main__':
    main()
