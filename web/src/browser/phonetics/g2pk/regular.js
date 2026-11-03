"use strict";

import { gloss } from "./utils.js";

function applyLiteralPairs(text, pairs) {
  return pairs.reduce((result, [from, to]) => result.replaceAll(from, to), text);
}

function buildLinkTransforms(ruleIdToText, logger) {
  return [
    function link1(input, options) {
      const output = applyLiteralPairs(input, [
        ["ᆨᄋ", "ᄀ"],
        ["ᆩᄋ", "ᄁ"],
        ["ᆫᄋ", "ᄂ"],
        ["ᆮᄋ", "ᄃ"],
        ["ᆯᄋ", "ᄅ"],
        ["ᆷᄋ", "ᄆ"],
        ["ᆸᄋ", "ᄇ"],
        ["ᆺᄋ", "ᄉ"],
        ["ᆻᄋ", "ᄊ"],
        ["ᆽᄋ", "ᄌ"],
        ["ᆾᄋ", "ᄎ"],
        ["ᆿᄋ", "ᄏ"],
        ["ᇀᄋ", "ᄐ"],
        ["ᇁᄋ", "ᄑ"]
      ]);
      gloss(options.verbose, output, input, ruleIdToText["13"], logger);
      return output;
    },
    function link2(input, options) {
      const output = applyLiteralPairs(input, [
        ["ᆪᄋ", "ᆨᄊ"],
        ["ᆬᄋ", "ᆫᄌ"],
        ["ᆰᄋ", "ᆯᄀ"],
        ["ᆱᄋ", "ᆯᄆ"],
        ["ᆲᄋ", "ᆯᄇ"],
        ["ᆳᄋ", "ᆯᄊ"],
        ["ᆴᄋ", "ᆯᄐ"],
        ["ᆵᄋ", "ᆯᄑ"],
        ["ᆹᄋ", "ᆸᄊ"]
      ]);
      gloss(options.verbose, output, input, ruleIdToText["14"], logger);
      return output;
    },
    function link3(input, options) {
      const output = applyLiteralPairs(input, [
        ["ᆨ ᄋ", " ᄀ"],
        ["ᆩ ᄋ", " ᄁ"],
        ["ᆫ ᄋ", " ᄂ"],
        ["ᆮ ᄋ", " ᄃ"],
        ["ᆯ ᄋ", " ᄅ"],
        ["ᆷ ᄋ", " ᄆ"],
        ["ᆸ ᄋ", " ᄇ"],
        ["ᆺ ᄋ", " ᄉ"],
        ["ᆻ ᄋ", " ᄊ"],
        ["ᆽ ᄋ", " ᄌ"],
        ["ᆾ ᄋ", " ᄎ"],
        ["ᆿ ᄋ", " ᄏ"],
        ["ᇀ ᄋ", " ᄐ"],
        ["ᇁ ᄋ", " ᄑ"],
        ["ᆪ ᄋ", "ᆨ ᄊ"],
        ["ᆬ ᄋ", "ᆫ ᄌ"],
        ["ᆰ ᄋ", "ᆯ ᄀ"],
        ["ᆱ ᄋ", "ᆯ ᄆ"],
        ["ᆲ ᄋ", "ᆯ ᄇ"],
        ["ᆳ ᄋ", "ᆯ ᄊ"],
        ["ᆴ ᄋ", "ᆯ ᄐ"],
        ["ᆵ ᄋ", "ᆯ ᄑ"],
        ["ᆹ ᄋ", "ᆸ ᄊ"]
      ]);
      gloss(options.verbose, output, input, ruleIdToText["15"], logger);
      return output;
    },
    function link4(input, options) {
      const output = applyLiteralPairs(input, [
        ["ᇂᄋ", "ᄋ"],
        ["ᆭᄋ", "ᄂ"],
        ["ᆶᄋ", "ᄅ"]
      ]);
      gloss(options.verbose, output, input, ruleIdToText["12.4"], logger);
      return output;
    }
  ];
}

export {
  buildLinkTransforms
};
