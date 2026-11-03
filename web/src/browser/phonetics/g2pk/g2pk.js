"use strict";

import { convertEng } from "./english.js";
import { convertNum } from "./numerals.js";
import { buildLinkTransforms } from "./regular.js";
import { buildSpecialTransforms } from "./special.js";
import {
  annotate,
  compose,
  decomposeHangulToJamo,
  getRuleIdToText,
  gloss,
  groupVowels,
  loadIdioms,
  parseTable
} from "./utils.js";

class G2p {
  constructor(options = {}) {
    const ruleData = options.ruleData;
    this.logger = typeof options.logger === "function" ? options.logger : console.log;
    this.morphAnalyzer = options.morphAnalyzer ?? null;
    this.englishDict = options.englishDict ?? null;
    this.table = parseTable(ruleData.table);
    this.ruleIdToText = getRuleIdToText(ruleData.rules);
    this.idiomRules = loadIdioms(ruleData.idioms);
    this.specialTransforms = buildSpecialTransforms(this.ruleIdToText, this.logger);
    this.linkTransforms = buildLinkTransforms(this.ruleIdToText, this.logger);
  }

  applyIdioms(text, options = {}) {
    let output = text;

    for (const idiomRule of this.idiomRules) {
      output = output.replace(idiomRule.regex, idiomRule.replacement);
    }

    gloss(options.verbose, output, text, "from idioms.txt", this.logger);
    return output;
  }

  async convert(text, options = {}) {
    const normalizedOptions = {
      descriptive: false,
      groupVowels: false,
      toSyllables: true,
      verbose: false,
      ...options
    };

    let output = this.applyIdioms(text, normalizedOptions);
    output = convertEng(output, this.englishDict);
    output = await annotate(output, this.morphAnalyzer);
    output = convertNum(output);
    output = decomposeHangulToJamo(output);

    for (const transform of this.specialTransforms) {
      output = transform(output, normalizedOptions);
    }

    output = output.replace(/\/[PJEB]/gu, "");

    for (const [pattern, replacement, ruleIds] of this.table) {
      const previous = output;
      output = output.replace(new RegExp(pattern, "gu"), replacement);

      const rule = ruleIds
        .map((ruleId) => this.ruleIdToText[ruleId] ?? "")
        .filter(Boolean)
        .join("\n");

      gloss(normalizedOptions.verbose, output, previous, rule, this.logger);
    }

    for (const transform of this.linkTransforms) {
      output = transform(output, normalizedOptions);
    }

    if (normalizedOptions.groupVowels) {
      output = groupVowels(output);
    }

    return normalizedOptions.toSyllables ? compose(output) : output;
  }
}

function createG2p(options = {}) {
  return new G2p(options);
}

export {
  G2p,
  createG2p
};
