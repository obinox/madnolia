"use strict";

const LEADS = [
  "ᄀ",
  "ᄁ",
  "ᄂ",
  "ᄃ",
  "ᄄ",
  "ᄅ",
  "ᄆ",
  "ᄇ",
  "ᄈ",
  "ᄉ",
  "ᄊ",
  "ᄋ",
  "ᄌ",
  "ᄍ",
  "ᄎ",
  "ᄏ",
  "ᄐ",
  "ᄑ",
  "ᄒ"
];

const VOWELS = [
  "ᅡ",
  "ᅢ",
  "ᅣ",
  "ᅤ",
  "ᅥ",
  "ᅦ",
  "ᅧ",
  "ᅨ",
  "ᅩ",
  "ᅪ",
  "ᅫ",
  "ᅬ",
  "ᅭ",
  "ᅮ",
  "ᅯ",
  "ᅰ",
  "ᅱ",
  "ᅲ",
  "ᅳ",
  "ᅴ",
  "ᅵ"
];

const TAILS = [
  "",
  "ᆨ",
  "ᆩ",
  "ᆪ",
  "ᆫ",
  "ᆬ",
  "ᆭ",
  "ᆮ",
  "ᆯ",
  "ᆰ",
  "ᆱ",
  "ᆲ",
  "ᆳ",
  "ᆴ",
  "ᆵ",
  "ᆶ",
  "ᆷ",
  "ᆸ",
  "ᆹ",
  "ᆺ",
  "ᆻ",
  "ᆼ",
  "ᆽ",
  "ᆾ",
  "ᆿ",
  "ᇀ",
  "ᇁ",
  "ᇂ"
];

const LEAD_SET = new Set(LEADS);
const VOWEL_SET = new Set(VOWELS);
const TAIL_SET = new Set(TAILS.filter(Boolean));

function isHangulSyllable(char) {
  if (!char) {
    return false;
  }

  const code = char.codePointAt(0);
  return code >= 0xac00 && code <= 0xd7a3;
}

function isLead(char) {
  return LEAD_SET.has(char);
}

function isVowel(char) {
  return VOWEL_SET.has(char);
}

function isTail(char) {
  return TAIL_SET.has(char);
}

function decomposeSyllable(char) {
  if (!isHangulSyllable(char)) {
    return char;
  }

  const syllableIndex = char.codePointAt(0) - 0xac00;
  const leadIndex = Math.floor(syllableIndex / 588);
  const vowelIndex = Math.floor((syllableIndex % 588) / 28);
  const tailIndex = syllableIndex % 28;

  return `${LEADS[leadIndex]}${VOWELS[vowelIndex]}${TAILS[tailIndex]}`;
}

function decomposeHangulToJamo(text) {
  return Array.from(text, (char) => decomposeSyllable(char)).join("");
}

function composeSyllable(lead, vowel, tail = "") {
  const leadIndex = LEADS.indexOf(lead);
  const vowelIndex = VOWELS.indexOf(vowel);
  const tailIndex = TAILS.indexOf(tail);

  if (leadIndex < 0 || vowelIndex < 0 || tailIndex < 0) {
    return `${lead}${vowel}${tail}`;
  }

  const codePoint = 0xac00 + ((leadIndex * 21) + vowelIndex) * 28 + tailIndex;
  return String.fromCodePoint(codePoint);
}

function compose(letters) {
  const chars = Array.from(letters);
  const output = [];

  for (let index = 0; index < chars.length; index += 1) {
    const current = chars[index];
    const next = chars[index + 1];
    const next2 = chars[index + 2];

    if (isLead(current) && isVowel(next)) {
      if (isTail(next2)) {
        output.push(composeSyllable(current, next, next2));
        index += 2;
        continue;
      }

      output.push(composeSyllable(current, next));
      index += 1;
      continue;
    }

    if (isVowel(current)) {
      if (isTail(next)) {
        output.push(composeSyllable("ᄋ", current, next));
        index += 1;
        continue;
      }

      output.push(composeSyllable("ᄋ", current));
      continue;
    }

    output.push(current);
  }

  return output.join("");
}

function groupVowels(input) {
  return input
    .replaceAll("ᅢ", "ᅦ")
    .replaceAll("ᅤ", "ᅨ")
    .replaceAll("ᅫ", "ᅬ")
    .replaceAll("ᅰ", "ᅬ");
}

function readUtf8(filePath) {
  return filePath;
}

function pythonReplacementToJs(replacement) {
  return replacement.replace(/\\(\d+)/gu, "$$$1");
}

function parseTable(filePath) {
  const lines = readUtf8(filePath).split(/\r?\n/u).filter(Boolean);
  const onsets = lines[0].split(",");
  const table = [];

  for (const line of lines.slice(1)) {
    const cols = line.split(",");
    const coda = cols[0];

    for (let index = 1; index < onsets.length; index += 1) {
      const onset = onsets[index];
      const cell = cols[index];
      if (!cell) {
        continue;
      }

      if (cell.includes("(")) {
        const splitIndex = cell.indexOf("(");
        const value = pythonReplacementToJs(cell.slice(0, splitIndex));
        const ruleIds = cell.slice(splitIndex + 1, -1).split("/");
        table.push([`${coda}${onset}`, value, ruleIds]);
        continue;
      }

      table.push([`${coda}${onset}`, pythonReplacementToJs(cell), []]);
    }
  }

  return table;
}

function getRuleIdToText(filePath) {
  const rules = readUtf8(filePath).trim().split(/\r?\n\r?\n/u);
  const result = {};

  for (const rule of rules) {
    const lines = rule.split(/\r?\n/u);
    const [ruleId, ...body] = lines;
    result[ruleId.trim()] = body.join("\n");
  }

  return result;
}

function loadIdioms(filePath) {
  return readUtf8(filePath)
    .split(/\r?\n/u)
    .map((line) => line.split("#")[0].trim())
    .filter((line) => line.includes("==="))
    .map((line) => {
      const [pattern, replacement] = line.split("===");
      return {
        pattern,
        replacement: pythonReplacementToJs(replacement),
        regex: new RegExp(pattern, "gu")
      };
    });
}

async function getMorphTokens(text, morphAnalyzer) {
  if (!morphAnalyzer) {
    return null;
  }

  if (typeof morphAnalyzer === "function") {
    return await morphAnalyzer(text);
  }

  if (typeof morphAnalyzer.pos === "function") {
    return await morphAnalyzer.pos(text);
  }

  throw new TypeError("morphAnalyzer must be a function or expose a pos(text) method.");
}

function normalizeMorphToken(entry) {
  if (Array.isArray(entry)) {
    return {
      token: String(entry[0] ?? ""),
      tag: String(entry[1] ?? "")
    };
  }

  if (entry && typeof entry === "object") {
    return {
      token: String(entry.token ?? entry.text ?? ""),
      tag: String(entry.tag ?? entry.pos ?? "")
    };
  }

  throw new TypeError("Each morph analyzer token must be an array or object.");
}

async function annotate(text, morphAnalyzer) {
  const rawTokens = await getMorphTokens(text, morphAnalyzer);
  if (!rawTokens) {
    return text;
  }

  const tokens = rawTokens.map(normalizeMorphToken);
  const flattenedText = text.replaceAll(" ", "");
  const flattenedTokens = tokens.map(({ token }) => token).join("");

  if (flattenedText !== flattenedTokens) {
    return text;
  }

  const blanks = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === " ") {
      blanks.push(index);
    }
  }

  const tagSequenceParts = [];
  for (const { token, tag } of tokens) {
    const finalTag = String(tag).split("+").at(-1) || "";
    const normalizedTag = finalTag === "NNBC" ? "B" : finalTag.slice(0, 1);
    tagSequenceParts.push(`${"_".repeat(Math.max(token.length - 1, 0))}${normalizedTag}`);
  }

  let tagSequence = tagSequenceParts.join("");
  for (const blankIndex of blanks) {
    tagSequence = `${tagSequence.slice(0, blankIndex)} ${tagSequence.slice(blankIndex)}`;
  }

  let annotated = "";
  const chars = Array.from(text);
  const tags = Array.from(tagSequence);

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    const tag = tags[index] || "";
    annotated += char;

    const decomposed = decomposeSyllable(char);
    const tail = decomposed.length >= 3 ? decomposed[2] : "";

    if (char === "의" && tag === "J") {
      annotated += "/J";
    } else if (tag === "E" && tail === "ᆯ") {
      annotated += "/E";
    } else if (tag === "V" && "ᆫᆬᆷᆱᆲᆴ".includes(tail)) {
      annotated += "/P";
    } else if (tag === "B") {
      annotated += "/B";
    }
  }

  return annotated;
}

function gloss(verbose, output, input, rule, logger = console.log) {
  if (!verbose || output === input || output === input.replace(/\/[EJPB]/gu, "")) {
    return;
  }

  logger(`${compose(input)} -> ${compose(output)}`);
  if (rule) {
    logger(rule);
  }
}

export {
  annotate,
  compose,
  composeSyllable,
  decomposeHangulToJamo,
  decomposeSyllable,
  getRuleIdToText,
  gloss,
  groupVowels,
  isLead,
  isTail,
  isVowel,
  loadIdioms,
  parseTable,
  readUtf8
};
