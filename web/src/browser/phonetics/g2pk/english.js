"use strict";

import { compose } from "./utils.js";

function adjust(arpabets) {
  let result = ` ${arpabets.join(" ")} $`;
  result = result.replace(/\d/gu, "");
  result = result.replaceAll(" T S ", " TS ");
  result = result.replaceAll(" D Z ", " DZ ");
  result = result.replaceAll(" AW ER ", " AWER ");
  result = result.replaceAll(" IH R $", " IH ER ");
  result = result.replaceAll(" EH R $", " EH ER ");
  result = result.replace(" $", "");
  return result.trim().split(/\s+/u).filter(Boolean);
}

function toChoseong(arpabet) {
  return {
    B: "ᄇ",
    CH: "ᄎ",
    D: "ᄃ",
    DH: "ᄃ",
    DZ: "ᄌ",
    F: "ᄑ",
    G: "ᄀ",
    HH: "ᄒ",
    JH: "ᄌ",
    K: "ᄏ",
    L: "ᄅ",
    M: "ᄆ",
    N: "ᄂ",
    NG: "ᄋ",
    P: "ᄑ",
    R: "ᄅ",
    S: "ᄉ",
    SH: "ᄉ",
    T: "ᄐ",
    TH: "ᄉ",
    TS: "ᄎ",
    V: "ᄇ",
    W: "W",
    Y: "Y",
    Z: "ᄌ",
    ZH: "ᄌ"
  }[arpabet] ?? arpabet;
}

function toJungseong(arpabet) {
  return {
    AA: "ᅡ",
    AE: "ᅢ",
    AH: "ᅥ",
    AO: "ᅩ",
    AW: "ᅡ우",
    AWER: "ᅡ워",
    AY: "ᅡ이",
    EH: "ᅦ",
    ER: "ᅥ",
    EY: "ᅦ이",
    IH: "ᅵ",
    IY: "ᅵ",
    OW: "ᅩ",
    OY: "ᅩ이",
    UH: "ᅮ",
    UW: "ᅮ"
  }[arpabet] ?? arpabet;
}

function toJongseong(arpabet) {
  return {
    B: "ᆸ",
    CH: "ᆾ",
    D: "ᆮ",
    DH: "ᆮ",
    F: "ᇁ",
    G: "ᆨ",
    HH: "ᇂ",
    JH: "ᆽ",
    K: "ᆨ",
    L: "ᆯ",
    M: "ᆷ",
    N: "ᆫ",
    NG: "ᆼ",
    P: "ᆸ",
    R: "ᆯ",
    S: "ᆺ",
    SH: "ᆺ",
    T: "ᆺ",
    TH: "ᆺ",
    V: "ᆸ",
    W: "ᆼ",
    Y: "ᆼ",
    Z: "ᆽ",
    ZH: "ᆽ"
  }[arpabet] ?? arpabet;
}

function reconstruct(text) {
  const replacements = [
    ["그W", "ᄀW"],
    ["흐W", "ᄒW"],
    ["크W", "ᄏW"],
    ["ᄂYᅥ", "니어"],
    ["ᄃYᅥ", "디어"],
    ["ᄅYᅥ", "리어"],
    ["Yᅵ", "ᅵ"],
    ["Yᅡ", "ᅣ"],
    ["Yᅢ", "ᅤ"],
    ["Yᅥ", "ᅧ"],
    ["Yᅦ", "ᅨ"],
    ["Yᅩ", "ᅭ"],
    ["Yᅮ", "ᅲ"],
    ["Wᅡ", "ᅪ"],
    ["Wᅢ", "ᅫ"],
    ["Wᅥ", "ᅯ"],
    ["Wᅩ", "ᅯ"],
    ["Wᅮ", "ᅮ"],
    ["Wᅦ", "ᅰ"],
    ["Wᅵ", "ᅱ"],
    ["ᅳᅵ", "ᅴ"],
    ["Y", "ᅵ"],
    ["W", "ᅮ"]
  ];

  return replacements.reduce(
    (result, [from, to]) => result.replaceAll(from, to),
    text
  );
}

function normalizePronunciationEntry(entry) {
  if (!entry) {
    return null;
  }

  if (typeof entry === "string") {
    return entry.trim().split(/\s+/u).filter(Boolean);
  }

  if (!Array.isArray(entry) || entry.length === 0) {
    return null;
  }

  if (Array.isArray(entry[0])) {
    return entry[0].map(String);
  }

  if (typeof entry[0] === "string" && entry.length === 1 && entry[0].includes(" ")) {
    return entry[0].trim().split(/\s+/u).filter(Boolean);
  }

  return entry.map(String);
}

function getPronunciation(dictionary, word) {
  if (!dictionary) {
    return null;
  }

  const entry = dictionary[word];
  return normalizePronunciationEntry(entry);
}

function convertEng(text, dictionary) {
  const englishWords = new Set(text.match(/[A-Za-z']+/gu) ?? []);

  for (const englishWord of englishWords) {
    const pronunciation = getPronunciation(dictionary, englishWord.toLowerCase());
    if (!pronunciation) {
      continue;
    }

    const phonemes = adjust(pronunciation);
    let result = "";

    for (let index = 0; index < phonemes.length; index += 1) {
      const phoneme = phonemes[index];
      const previous = index > 0 ? phonemes[index - 1] : "^";
      const next = index < phonemes.length - 1 ? phonemes[index + 1] : "$";
      const next2 = index < phonemes.length - 2 ? phonemes[index + 2] : "$";

      const shortVowels = new Set(["AE", "AH", "AX", "EH", "IH", "IX", "UH"]);
      const vowels = "AEIOUY";
      const consonants = "BCDFGHJKLMNPQRSTVWXZ";
      const syllableFinalOrConsonants = "$BCDFGHJKLMNPQRSTVWXZ";

      if ("PTK".includes(phoneme)) {
        if (shortVowels.has(previous.slice(0, 2)) && next === "$") {
          result += toJongseong(phoneme);
        } else if (
          shortVowels.has(previous.slice(0, 2)) &&
          !("AEIOULRMN".includes(next[0]))
        ) {
          result += toJongseong(phoneme);
        } else if (syllableFinalOrConsonants.includes(next[0])) {
          result += `${toChoseong(phoneme)}ᅳ`;
        } else {
          result += toChoseong(phoneme);
        }
      } else if ("BDG".includes(phoneme)) {
        result += toChoseong(phoneme);
        if (syllableFinalOrConsonants.includes(next[0])) {
          result += "ᅳ";
        }
      } else if (["S", "Z", "F", "V", "TH", "DH", "SH", "ZH"].includes(phoneme)) {
        result += toChoseong(phoneme);

        if (["S", "Z", "F", "V", "TH", "DH"].includes(phoneme)) {
          if (syllableFinalOrConsonants.includes(next[0])) {
            result += "ᅳ";
          }
        } else if (phoneme === "SH") {
          if (next[0] === "$") {
            result += "ᅵ";
          } else if (consonants.includes(next[0])) {
            result += "ᅲ";
          } else {
            result += "Y";
          }
        } else if (phoneme === "ZH" && syllableFinalOrConsonants.includes(next[0])) {
          result += "ᅵ";
        }
      } else if (["TS", "DZ", "CH", "JH"].includes(phoneme)) {
        result += toChoseong(phoneme);

        if (syllableFinalOrConsonants.includes(next[0])) {
          result += ["TS", "DZ"].includes(phoneme) ? "ᅳ" : "ᅵ";
        }
      } else if (["M", "N", "NG"].includes(phoneme)) {
        if ("MN".includes(phoneme) && vowels.includes(next[0])) {
          result += toChoseong(phoneme);
        } else {
          result += toJongseong(phoneme);
        }
      } else if (phoneme === "L") {
        if (previous === "^") {
          result += toChoseong(phoneme);
        } else if ("$BCDFGHJKLPQRSTVWXZ".includes(next[0])) {
          result += toJongseong(phoneme);
        } else if ("MN".includes(previous)) {
          result += toChoseong(phoneme);
        } else if (vowels.includes(next[0])) {
          result += "ᆯᄅ";
        } else if ("MN".includes(next) && !vowels.includes(next2[0])) {
          result += "ᆯ르";
        }
      } else if (phoneme === "ER") {
        if (vowels.includes(previous[0])) {
          result += "ᄋ";
        }

        result += toJungseong(phoneme);

        if (vowels.includes(next[0])) {
          result += "ᄅ";
        }
      } else if (phoneme === "R") {
        if (vowels.includes(next[0])) {
          result += toChoseong(phoneme);
        }
      } else if ("AEIOU".includes(phoneme[0])) {
        result += toJungseong(phoneme);
      } else {
        result += toChoseong(phoneme);
      }
    }

    result = reconstruct(result);
    result = compose(result);
    result = result.replace(/[\u1100-\u11ff]/gu, "");
    text = text.replaceAll(englishWord, result);
  }

  return text;
}

export {
  convertEng
};
