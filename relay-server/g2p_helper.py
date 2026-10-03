"""Grapheme-to-phoneme helper, run with Kokoro's Python (it has misaki).

Kokoro's own /dev/phonemize builds a new pipeline per request (~1.1s); kept
loaded here it takes a few ms.  The relay starts this once and talks to it
over stdin/stdout, one JSON object per line:

    in:  {"id": 1, "words": ["Hello", "forty-two", "README"]}
    out: {"id": 1, "phonemes": ["həlˈO", "fˈɔɹTitˌu", "ˌɑɹˌiˌAdˌiˌɛmˈi"]}

`phonemes` has one entry per word (null where a word produced nothing).  The
words are the caption tokens Kokoro already normalized ("forty-two", not
"42"), so phonemizing them joined by spaces yields one group per word; if the
counts ever disagree, each word is phonemized on its own instead.
"""

import json
import sys
import warnings

warnings.filterwarnings("ignore")


def main():
    from kokoro import KPipeline

    pipeline = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M", model=False)

    def phonemize(text: str) -> str:
        return " ".join(r.phonemes for r in pipeline(text) if r.phonemes)

    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        try:
            req = json.loads(line)
            words = [str(w) for w in req.get("words", [])]
            groups = phonemize(" ".join(words)).split() if words else []
            if len(groups) != len(words):
                groups = [phonemize(w).replace(" ", "") or None for w in words]
            out = {"id": req.get("id"), "phonemes": groups}
        except Exception as e:  # keep serving; the relay treats errors as "no phonemes"
            out = {"id": None, "error": str(e)}
        print(json.dumps(out, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
