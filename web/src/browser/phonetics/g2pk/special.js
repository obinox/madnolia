"use strict";

import { gloss } from "./utils.js";

function applyLiteralPairs(text, pairs) {
  return pairs.reduce((result, [from, to]) => result.replaceAll(from, to), text);
}

function buildSpecialTransforms(ruleIdToText, logger) {
  return [
    function jyeo(input, options) {
      const output = input.replace(/([ᄌᄍᄎ])ᅧ/gu, "$1ᅥ");
      gloss(options.verbose, output, input, ruleIdToText["5.1"], logger);
      return output;
    },
    function ye(input, options) {
      const output = options.descriptive
        ? input.replace(/([ᄀᄁᄃᄄᄅᄆᄇᄈᄌᄍᄎᄏᄐᄑᄒ])ᅨ/gu, "$1ᅦ")
        : input;
      gloss(options.verbose, output, input, ruleIdToText["5.2"], logger);
      return output;
    },
    function consonantUi(input, options) {
      const output = input.replace(/([ᄀᄁᄂᄃᄄᄅᄆᄇᄈᄉᄊᄌᄍᄎᄏᄐᄑᄒ])ᅴ/gu, "$1ᅵ");
      gloss(options.verbose, output, input, ruleIdToText["5.3"], logger);
      return output;
    },
    function josaUi(input, options) {
      const output = options.descriptive
        ? input.replace(/의\/J/gu, "에")
        : input.replace(/\/J/gu, "");
      gloss(options.verbose, output, input, ruleIdToText["5.4.2"], logger);
      return output;
    },
    function vowelUi(input, options) {
      const output = options.descriptive
        ? input.replace(/(\Sᄋ)ᅴ/gu, "$1ᅵ")
        : input;
      gloss(options.verbose, output, input, ruleIdToText["5.4.1"], logger);
      return output;
    },
    function jamo(input, options) {
      let output = input;
      output = output.replace(/([그])ᆮᄋ/gu, "$1ᄉ");
      output = output.replace(/([으])[ᆽᆾᇀᇂ]ᄋ/gu, "$1ᄉ");
      output = output.replace(/([으])ᆿᄋ/gu, "$1ᄀ");
      output = output.replace(/([으])ᇁᄋ/gu, "$1ᄇ");
      gloss(options.verbose, output, input, ruleIdToText["16"], logger);
      return output;
    },
    function rieulgiyeok(input, options) {
      const output = input.replace(/ᆰ\/P([ᄀᄁ])/gu, "ᆯᄁ");
      gloss(options.verbose, output, input, ruleIdToText["11.1"], logger);
      return output;
    },
    function rieulbieub(input, options) {
      let output = input;
      output = output.replace(/([ᆲᆴ])\/Pᄀ/gu, "$1ᄁ");
      output = output.replace(/([ᆲᆴ])\/Pᄃ/gu, "$1ᄄ");
      output = output.replace(/([ᆲᆴ])\/Pᄉ/gu, "$1ᄊ");
      output = output.replace(/([ᆲᆴ])\/Pᄌ/gu, "$1ᄍ");
      gloss(options.verbose, output, input, ruleIdToText["25"], logger);
      return output;
    },
    function verbNieun(input, options) {
      const pairs = [
        [/([ᆫᆷ])\/Pᄀ/gu, "$1ᄁ"],
        [/([ᆫᆷ])\/Pᄃ/gu, "$1ᄄ"],
        [/([ᆫᆷ])\/Pᄉ/gu, "$1ᄊ"],
        [/([ᆫᆷ])\/Pᄌ/gu, "$1ᄍ"],
        [/ᆬ\/Pᄀ/gu, "ᆫᄁ"],
        [/ᆬ\/Pᄃ/gu, "ᆫᄄ"],
        [/ᆬ\/Pᄉ/gu, "ᆫᄊ"],
        [/ᆬ\/Pᄌ/gu, "ᆫᄍ"],
        [/ᆱ\/Pᄀ/gu, "ᆷᄁ"],
        [/ᆱ\/Pᄃ/gu, "ᆷᄄ"],
        [/ᆱ\/Pᄉ/gu, "ᆷᄊ"],
        [/ᆱ\/Pᄌ/gu, "ᆷᄍ"]
      ];

      const output = pairs.reduce(
        (result, [pattern, replacement]) => result.replace(pattern, replacement),
        input
      );
      gloss(options.verbose, output, input, ruleIdToText["24"], logger);
      return output;
    },
    function balb(input, options) {
      let output = input;
      output = output.replace(/(바)ᆲ($|[^ᄋᄒ])/gu, "$1ᆸ$2");
      output = output.replace(/(너)ᆲ([ᄌᄍ]ᅮ|[ᄃᄄ]ᅮ)/gu, "$1ᆸ$2");
      gloss(options.verbose, output, input, ruleIdToText["10.1"], logger);
      return output;
    },
    function palatalize(input, options) {
      let output = input;
      output = output.replace(/ᆮᄋ([ᅵᅧ])/gu, "ᄌ$1");
      output = output.replace(/ᇀᄋ([ᅵᅧ])/gu, "ᄎ$1");
      output = output.replace(/ᆴᄋ([ᅵᅧ])/gu, "ᆯᄎ$1");
      output = output.replace(/ᆮᄒ(ᅵ)/gu, "ᄎ$1");
      gloss(options.verbose, output, input, ruleIdToText["17"], logger);
      return output;
    },
    function modifyingRieul(input, options) {
      const output = applyLiteralPairs(
        input
          .replace(/ᆯ\/E ᄀ/gu, "ᆯ ᄁ")
          .replace(/ᆯ\/E ᄃ/gu, "ᆯ ᄄ")
          .replace(/ᆯ\/E ᄇ/gu, "ᆯ ᄈ")
          .replace(/ᆯ\/E ᄉ/gu, "ᆯ ᄊ")
          .replace(/ᆯ\/E ᄌ/gu, "ᆯ ᄍ"),
        [
          ["ᆯ걸", "ᆯ껄"],
          ["ᆯ밖에", "ᆯ빠께"],
          ["ᆯ세라", "ᆯ쎄라"],
          ["ᆯ수록", "ᆯ쑤록"],
          ["ᆯ지라도", "ᆯ찌라도"],
          ["ᆯ지언정", "ᆯ찌언정"],
          ["ᆯ진대", "ᆯ찐대"]
        ]
      );
      gloss(options.verbose, output, input, ruleIdToText["27"], logger);
      return output;
    }
  ];
}

export {
  buildSpecialTransforms
};
