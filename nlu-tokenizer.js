// Inera Edit Flow — BERT WordPiece tokenizer (uncased) for the all-MiniLM-L6-v2 sentence model.
export class WordPiece {
  constructor(vocabText) {
    this.tokens = vocabText.split('\n');
    this.ids = new Map(this.tokens.map((t, i) => [t, i]));
    this.unk = this.ids.get('[UNK]'); this.cls = this.ids.get('[CLS]'); this.sep = this.ids.get('[SEP]');
  }
  static isPunct(cp) {
    if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) return true;
    return /\p{P}/u.test(String.fromCodePoint(cp));
  }
  static isCJK(cp) {
    return (cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF) || (cp >= 0x20000 && cp <= 0x2A6DF) || (cp >= 0x2A700 && cp <= 0x2B73F)
      || (cp >= 0x2B740 && cp <= 0x2B81F) || (cp >= 0x2B820 && cp <= 0x2CEAF) || (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0x2F800 && cp <= 0x2FA1F);
  }
  basic(text) {
    // clean text: drop control chars, normalise whitespace
    let s = '';
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp === 0 || cp === 0xFFFD || (/\p{Cc}|\p{Cf}/u.test(ch) && !/[\t\n\r]/.test(ch))) continue;
      s += /\s/.test(ch) ? ' ' : ch;
    }
    // CJK chars become separate words
    let t = '';
    for (const ch of s) { const cp = ch.codePointAt(0); t += WordPiece.isCJK(cp) ? ` ${ch} ` : ch; }
    t = t.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
    const out = [];
    for (const w of t.split(/\s+/)) {
      if (!w) continue;
      let cur = '';
      for (const ch of w) {
        if (WordPiece.isPunct(ch.codePointAt(0))) { if (cur) out.push(cur); out.push(ch); cur = ''; } else cur += ch;
      }
      if (cur) out.push(cur);
    }
    return out;
  }
  wordpiece(word) {
    if ([...word].length > 100) return [this.unk];
    const out = []; let start = 0; const chars = [...word];
    while (start < chars.length) {
      let end = chars.length, id = null;
      while (start < end) {
        let sub = chars.slice(start, end).join('');
        if (start > 0) sub = '##' + sub;
        if (this.ids.has(sub)) { id = this.ids.get(sub); break; }
        end--;
      }
      if (id === null) return [this.unk];
      out.push(id); start = end;
    }
    return out;
  }
  encode(text, maxLen = 128) {
    const ids = [this.cls];
    for (const w of this.basic(text)) { for (const id of this.wordpiece(w)) ids.push(id); }
    if (ids.length > maxLen - 1) ids.length = maxLen - 1;
    ids.push(this.sep);
    return ids;
  }
}
