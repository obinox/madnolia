import json
from pathlib import Path


def main() -> None:
    directory = Path("data/cache/qwen-benchmark")
    results = [
        json.loads(
            (path.with_name(f"{path.stem}-batched.json")
             if path.with_name(f"{path.stem}-batched.json").is_file() else path).read_text(
                encoding="utf-8"
            )
        )
        for path in sorted(directory.glob("now-2026-09-10-*.json"))
        if not path.stem.endswith("-batched")
    ]
    data = json.dumps(results, ensure_ascii=False).replace("<", "\\u003c")
    page = """<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Maple Now 2026.09.10 · 30~40분 전사 비교</title>
<style>
  :root { font-family: system-ui, sans-serif; color: #e8edf7; background: #101626; }
  body { margin: 0 auto; padding: 28px; max-width: 1500px; }
  h1 { margin: 0 0 8px; font-size: 27px; }
  p { color: #b7c2d6; line-height: 1.6; }
  audio { width: min(100%, 600px); margin: 8px 0 24px; }
  .summary, .panels { display: grid; gap: 14px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .summary { grid-template-columns: repeat(3, minmax(0, 1fr)); margin: 20px 0 28px; }
  .card, .panel { background: #1b2437; border: 1px solid #324158; border-radius: 12px; padding: 18px; }
  .card { cursor: pointer; text-align: left; color: inherit; font: inherit; }
  .card:hover, .card:focus-visible { border-color: #68c9ff; }
  .card strong, .card small { display: block; margin-bottom: 8px; }
  .card small { color: #b7c2d6; }
  .card span { color: #d4ddeb; line-height: 1.55; }
  label { display: block; margin-bottom: 12px; font-weight: 650; }
  select { width: 100%; margin-top: 8px; padding: 9px; color: #e8edf7; background: #101626; border: 1px solid #536782; border-radius: 7px; }
  .text { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.85; font-size: 16px; }
  mark { background: #85502c; color: #fff6df; border-radius: 3px; }
  .meta { color: #b7c2d6; margin-bottom: 16px; }
  @media (max-width: 850px) { .summary, .panels { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<h1>2026년 9월 Maple Now · 30:00~40:00</h1>
<p>모델 두 개를 골라 전사문을 나란히 비교하세요. 주황색은 상대 전사문과 일치하지 않는 어절입니다. 표시된 차이는 정확도 판정이 아닙니다.</p>
<audio controls preload="none" src="maple-now-2026-09-10-30m-40m.wav"></audio>
<h2>전체 모델</h2>
<div id="summary" class="summary"></div>
<h2>전사문 비교</h2>
<div class="panels">
  <section class="panel"><label>왼쪽 모델<select id="left"></select></label><div id="left-meta" class="meta"></div><div id="left-text" class="text"></div></section>
  <section class="panel"><label>오른쪽 모델<select id="right"></select></label><div id="right-meta" class="meta"></div><div id="right-text" class="text"></div></section>
</div>
<script>
(() => {
  const results = __RESULTS__;
  const order = ['large-v3', 'large-v3-turbo', 'small', 'tiny', 'qwen3-asr-0.6b', 'qwen3-asr-1.7b'];
  results.sort((a, b) => order.indexOf(a.model) - order.indexOf(b.model));
  const left = document.getElementById('left');
  const right = document.getElementById('right');
  const summary = document.getElementById('summary');
  for (const [index, result] of results.entries()) {
    for (const select of [left, right]) {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = result.model + ' · ' + result.device;
      select.append(option);
    }
    const card = document.createElement('button');
    card.className = 'card';
    const title = document.createElement('strong');
    title.textContent = result.model;
    const time = document.createElement('small');
    time.textContent = result.device + ' · ' + result.total_seconds.toFixed(2) + '초';
    const excerpt = document.createElement('span');
    excerpt.textContent = result.transcript.slice(0, 130) + '…';
    card.append(title, time, excerpt);
    card.addEventListener('click', () => { right.value = String(index); render(); document.querySelector('.panels').scrollIntoView({behavior: 'smooth'}); });
    summary.append(card);
  }
  left.value = '1';
  right.value = '4';
  function differences(a, b) {
    const width = b.length + 1;
    const table = new Uint16Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 :
          Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    const equalA = new Uint8Array(a.length);
    const equalB = new Uint8Array(b.length);
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { equalA[i++] = 1; equalB[j++] = 1; }
      else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i++;
      else j++;
    }
    return [equalA, equalB];
  }
  function show(name, result, words, equal) {
    document.getElementById(name + '-meta').textContent = result.total_seconds.toFixed(2) + '초 · ' + result.word_count + '개 단어 구간';
    const target = document.getElementById(name + '-text');
    target.replaceChildren();
    const fragment = document.createDocumentFragment();
    words.forEach((word, index) => {
      if (index) fragment.append(document.createTextNode(' '));
      if (equal[index]) fragment.append(document.createTextNode(word));
      else { const highlight = document.createElement('mark'); highlight.textContent = word; fragment.append(highlight); }
    });
    target.append(fragment);
  }
  function render() {
    const a = results[Number(left.value)];
    const b = results[Number(right.value)];
    const aw = a.transcript.trim().split(/\\s+/);
    const bw = b.transcript.trim().split(/\\s+/);
    const [ae, be] = differences(aw, bw);
    show('left', a, aw, ae);
    show('right', b, bw, be);
  }
  left.addEventListener('change', render);
  right.addEventListener('change', render);
  render();
})();
</script>
</body>
</html>"""
    destination = directory / "now-2026-09-10-comparison.html"
    destination.write_text(page.replace("__RESULTS__", data), encoding="utf-8")
    print(destination)


if __name__ == "__main__":
    main()
