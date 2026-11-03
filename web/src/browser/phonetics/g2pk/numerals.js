"use strict";

const BOUND_NOUNS = new Set(
  "군데 권 개 그루 닢 대 두 마리 모 모금 뭇 발 발짝 방 번 벌 보루 살 수 술 시 쌈 움큼 정 짝 채 척 첩 축 켤레 톨 통".split(" ")
);

function processNum(num, sino = true) {
  const normalized = num.replaceAll(",", "");

  if (normalized === "0") {
    return "영";
  }

  if (!sino && normalized === "20") {
    return "스무";
  }

  const digit2name = Object.fromEntries(
    Array.from("123456789").map((digit, index) => [digit, Array.from("일이삼사오육칠팔구")[index]])
  );
  const digit2mod = Object.fromEntries(
    Array.from("123456789").map((digit, index) => [digit, "한 두 세 네 다섯 여섯 일곱 여덟 아홉".split(" ")[index]])
  );
  const digit2dec = Object.fromEntries(
    Array.from("123456789").map((digit, index) => [digit, "열 스물 서른 마흔 쉰 예순 일흔 여든 아흔".split(" ")[index]])
  );

  const spelledOut = [];

  for (let index = 0; index < normalized.length; index += 1) {
    const digit = normalized[index];
    const power = normalized.length - index - 1;
    let name = "";

    if (sino) {
      if (power === 0) {
        name = digit2name[digit] ?? "";
      } else if (power === 1) {
        name = `${digit2name[digit] ?? ""}십`.replace("일십", "십");
      }
    } else if (power === 0) {
      name = digit2mod[digit] ?? "";
    } else if (power === 1) {
      name = digit2dec[digit] ?? "";
    }

    if (digit === "0") {
      if (power % 4 === 0) {
        const lastThree = spelledOut.slice(-Math.min(3, spelledOut.length));
        if (lastThree.join("") === "") {
          spelledOut.push("");
          continue;
        }
      } else {
        spelledOut.push("");
        continue;
      }
    }

    if (power === 2) {
      name = `${digit2name[digit] ?? ""}백`.replace("일백", "백");
    } else if (power === 3) {
      name = `${digit2name[digit] ?? ""}천`.replace("일천", "천");
    } else if (power === 4) {
      name = `${digit2name[digit] ?? ""}만`.replace("일만", "만");
    } else if (power === 5) {
      name = `${digit2name[digit] ?? ""}십`.replace("일십", "십");
    } else if (power === 6) {
      name = `${digit2name[digit] ?? ""}백`.replace("일백", "백");
    } else if (power === 7) {
      name = `${digit2name[digit] ?? ""}천`.replace("일천", "천");
    } else if (power === 8) {
      name = `${digit2name[digit] ?? ""}억`;
    } else if (power === 9) {
      name = `${digit2name[digit] ?? ""}십`;
    } else if (power === 10) {
      name = `${digit2name[digit] ?? ""}백`;
    } else if (power === 11) {
      name = `${digit2name[digit] ?? ""}천`;
    } else if (power === 12) {
      name = `${digit2name[digit] ?? ""}조`;
    } else if (power === 13) {
      name = `${digit2name[digit] ?? ""}십`;
    } else if (power === 14) {
      name = `${digit2name[digit] ?? ""}백`;
    } else if (power === 15) {
      name = `${digit2name[digit] ?? ""}천`;
    }

    spelledOut.push(name);
  }

  return spelledOut.join("");
}

function convertNum(text) {
  let result = text;
  const tokens = new Set(
    Array.from(result.matchAll(/([\d][\d,]*)([ㄱ-힣]+)\/B/gu), (match) => `${match[1]}\u0000${match[2]}`)
  );

  for (const token of tokens) {
    const [num, boundNoun] = token.split("\u0000");
    const spelledOut = BOUND_NOUNS.has(boundNoun)
      ? processNum(num, false)
      : processNum(num, true);
    result = result.replaceAll(`${num}${boundNoun}/B`, `${spelledOut}${boundNoun}/B`);
  }

  const names = "영일이삼사오육칠팔구";
  for (let digit = 0; digit <= 9; digit += 1) {
    result = result.replaceAll(String(digit), names[digit]);
  }

  return result;
}

export {
  BOUND_NOUNS,
  convertNum,
  processNum
};
