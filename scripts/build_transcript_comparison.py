import argparse
import json
from difflib import SequenceMatcher
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    results = [json.loads(path.read_text(encoding="utf-8")) for path in args.input.glob("now-2026-09-10-*.json")]
    if len(results) != 6:
        raise ValueError(f"Expected six transcript results, found {len(results)}")
    results.sort(key=lambda result: result["total_seconds"])
    payload = []
    for result in results:
        payload.append({
            "name": result["model"],
            "backend": result["backend"],
            "device": result["device"],
            "seconds": result["total_seconds"],
            "words": result["word_count"],
            "transcript": result["transcript"],
        })
    differences = {}
    for left in payload:
        for right in payload:
            if left["name"] == right["name"]:
                continue
            left_words = left["transcript"].split()
            right_words = right["transcript"].split()
            matcher = SequenceMatcher(None, left_words, right_words, autojunk=False)
            differences[f'{left["name"]}|{right["name"]}'] = [
                [tag, " ".join(left_words[a:b]), " ".join(right_words[c:d])]
                for tag, a, b, c, d in matcher.get_opcodes()
            ]
    data = json.dumps({"models": payload, "differences": differences}, ensure_ascii=False).replace("<", "\\u003c")
    page = r'''<!doctype html>
<html lang="ko">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Maple Now 2026.09.10 전사 비교</title>
<style>
  :root { font-family: system-ui, "Malgun Gothic", sans-serif; color: #192335; background: #f5f6f9; }
  body { max-width: 1400px; margin: 0 auto; padding: 26px 22px 80px; }
  h1 { font-size: 26px; margin-bottom: 5px; }
  p { line-height: 1.6; color: #586579; }
  .controls { display: flex; gap: 16px; align-items: end; flex-wrap: wrap; padding: 20px; background: white; border: 1px solid #dfe4ec; border-radius: 14px; margin: 20px 0; }
  label { display: grid; gap: 7px; font-weight: 650; }
  select, button { font: inherit; background: white; border: 1px solid #cad4e1; border-radius: 8px; padding: 9px 12px; }
  select { min-width: 210px; }
  button { cursor: pointer; }
  button[aria-pressed="true"] { background: #223e70; color: white; }
  #summary { font-weight: 650; margin: 16px 0; }
  .columns { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .column { min-width: 0; background: white; border: 1px solid #dfe4ec; border-radius: 12px; overflow: hidden; }
  .column h2 { font-size: 17px; margin: 0; padding: 17px 20px; background: #eef2f8; }
  .column h2 small { display: block; font-size: 13px; font-weight: 400; color: #54627a; margin-top: 5px; }
  .transcript { padding: 10px 20px 24px; max-height: 68vh; overflow: auto; }
  .segment { min-height: 32px; line-height: 1.85; padding: 7px 0; border-bottom: 1px solid #eef0f4; overflow-wrap: anywhere; }
  .segment.changed { background: #f9fafd; }
  mark { padding: 3px 2px; border-radius: 4px; color: inherit; }
  .removed { background: #ffdddd; }
  .added { background: #d9f4df; }
  .empty { color: #a3afbc; }
  .compact .segment.equal { display: none; }
  @media (max-width: 720px) { body { padding: 16px 10px; } .columns { grid-template-columns: 1fr; } .transcript { max-height: 42vh; } }
</style>
<h1>2026년 9월 Maple Now · 전사 비교</h1>
<p>9월 10일 영상 30:00–40:00의 같은 오디오입니다. 두 모델을 선택하면 어절 단위로 다른 부분을 표시합니다. 빨강은 왼쪽 전사, 초록은 오른쪽 전사입니다. 표시된 차이는 정답 여부를 뜻하지 않습니다.</p>
<div class="controls">
  <label>왼쪽 모델<select id="left"></select></label>
  <label>오른쪽 모델<select id="right"></select></label>
  <button type="button" id="only" aria-pressed="false">차이만 보기</button>
</div>
<div id="summary"></div>
<div class="columns" id="columns">
  <section class="column"><h2 id="left-title"></h2><div class="transcript" id="left-text"></div></section>
  <section class="column"><h2 id="right-title"></h2><div class="transcript" id="right-text"></div></section>
</div>
<script id="data" type="application/json">__DATA__</script>
<script>
  const data = JSON.parse(document.getElementById("data").textContent);
  const leftSelect = document.getElementById("left");
  const rightSelect = document.getElementById("right");
  const columns = document.getElementById("columns");
  const only = document.getElementById("only");
  const escapeText = (value) => { const element = document.createElement("span"); element.textContent = value; return element.innerHTML; };
  for (const model of data.models) {
    for (const select of [leftSelect, rightSelect]) {
      const option = document.createElement("option");
      option.value = model.name;
      option.textContent = model.name;
      select.append(option);
    }
  }
  leftSelect.value = "large-v3-turbo";
  rightSelect.value = "qwen3-asr-0.6b";
  function render() {
    const left = data.models.find((model) => model.name === leftSelect.value);
    const right = data.models.find((model) => model.name === rightSelect.value);
    const chunks = left.name === right.name
      ? [["equal", left.transcript, right.transcript]]
      : data.differences[left.name + "|" + right.name];
    let matching = 0;
    let changed = 0;
    const leftRows = [];
    const rightRows = [];
    for (const [kind, leftText, rightText] of chunks) {
      if (kind === "equal") matching += leftText.split(/\s+/).filter(Boolean).length;
      else changed++;
      const className = kind === "equal" ? "equal" : "changed";
      const text = (value, highlight) => value
        ? (highlight ? `<mark class="${highlight}">${escapeText(value)}</mark>` : escapeText(value))
        : '<span class="empty">·</span>';
      leftRows.push(`<div class="segment ${className}">${text(leftText, kind === "equal" ? "" : "removed")}</div>`);
      rightRows.push(`<div class="segment ${className}">${text(rightText, kind === "equal" ? "" : "added")}</div>`);
    }
    document.getElementById("left-text").innerHTML = leftRows.join("");
    document.getElementById("right-text").innerHTML = rightRows.join("");
    for (const [side, model] of [["left", left], ["right", right]]) {
      document.getElementById(side + "-title").innerHTML = `${escapeText(model.name)}<small>${escapeText(model.device)} · ${model.seconds.toFixed(2)}초 · ${model.words}단어</small>`;
      document.getElementById(side + "-text").scrollTop = 0;
    }
    document.getElementById("summary").textContent = `같은 어절 ${matching}개 · 차이가 있는 구간 ${changed}개`;
  }
  leftSelect.addEventListener("change", render);
  rightSelect.addEventListener("change", render);
  only.addEventListener("click", () => {
    const enabled = only.getAttribute("aria-pressed") !== "true";
    only.setAttribute("aria-pressed", String(enabled));
    columns.classList.toggle("compact", enabled);
    only.textContent = enabled ? "전체 보기" : "차이만 보기";
  });
  let syncing = false;
  for (const [source, target] of [["left-text", "right-text"], ["right-text", "left-text"]]) {
    document.getElementById(source).addEventListener("scroll", () => {
      if (syncing) return;
      syncing = true;
      const from = document.getElementById(source);
      const to = document.getElementById(target);
      const extent = from.scrollHeight - from.clientHeight;
      to.scrollTop = extent > 0 ? from.scrollTop / extent * (to.scrollHeight - to.clientHeight) : 0;
      requestAnimationFrame(() => { syncing = false; });
    });
  }
  render();
</script>
</html>'''
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(page.replace("__DATA__", data), encoding="utf-8")
    print(args.output)


if __name__ == "__main__":
    main()
