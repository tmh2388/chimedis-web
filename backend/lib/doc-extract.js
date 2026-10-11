/**
 * doc-extract.js — lấy văn bản thuần từ tệp người dùng tải lên cho "Tự Thêm".
 *
 * Hỗ trợ: .docx (Word), .pdf (có lớp chữ), .txt/.md. Không hỗ trợ: .doc cũ (nhị phân), PDF dạng ảnh scan (cần OCR).
 * Lỗi trả về dạng Error có .code: unsupported_type | scanned_pdf | empty_file | extract_failed.
 */
import mammoth from 'mammoth';
import { getDocumentProxy, extractText as pdfExtract } from 'unpdf';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_RETURN_CHARS = 60000;

const fail = (code) => Object.assign(new Error(code), { code });

function detectKind(buf, name) {
  const ext = (String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
  const head = buf.subarray(0, 5).toString('latin1');
  if (head.startsWith('%PDF')) return 'pdf';
  if (buf[0] === 0x50 && buf[1] === 0x4b) return ext === 'docx' || ext === '' ? 'docx' : (ext === 'odt' ? 'unsupported' : 'docx');
  if (buf[0] === 0xd0 && buf[1] === 0xcf) return 'unsupported'; // .doc cũ (OLE)
  if (['txt', 'md', 'markdown', 'text', ''].includes(ext)) return 'text';
  return 'unsupported';
}

function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('�')) return utf8.replace(/^﻿/, '');
  try { return new TextDecoder('gb18030').decode(buf); } catch (_) { return utf8; }
}

function tidy(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** @returns {{text: string, total_chars: number, kind: string}} text đã cắt tối đa MAX_RETURN_CHARS. */
export async function extractText(buffer, filename) {
  if (!buffer || !buffer.length) throw fail('empty_file');
  const kind = detectKind(buffer, filename);
  if (kind === 'unsupported') throw fail('unsupported_type');
  let raw = '';
  try {
    if (kind === 'pdf') {
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      raw = (await pdfExtract(pdf, { mergePages: true })).text;
    }
    else if (kind === 'docx') raw = (await mammoth.extractRawText({ buffer })).value;
    else raw = decodeText(buffer);
  } catch (e) {
    console.error('doc-extract:', kind, e.message);
    throw fail('extract_failed');
  }
  const text = tidy(raw);
  if (!text) throw fail(kind === 'pdf' ? 'scanned_pdf' : 'empty_file');
  return { text: text.slice(0, MAX_RETURN_CHARS), total_chars: text.length, kind };
}
