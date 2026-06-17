from __future__ import annotations

import json
import re
from pathlib import Path

from docx import Document


SOURCE_CANDIDATES = [
    Path(r"D:\BIZ\TOYS AI\LUNARA TOY - SERVER\LUMI_CONTENT_FACTORY"),
    Path(r"D:\BIZ\TOYS AI\LUMI_CONTENT_FACTORY"),
]
SOURCE_DIR = next((path for path in SOURCE_CANDIDATES if path.exists()), SOURCE_CANDIDATES[0])
OUT_PATH = Path(__file__).resolve().parents[1] / "data" / "content_seed.json"

DOCS = {
    "01_RIDDLE_TEMPLATES.docx": "riddle_template",
    "02_STORY_TEMPLATES.docx": "story_template",
    "03_FAIRYTALE_TEMPLATES.docx": "fairytale_template",
    "04_ANIMALS.docx": "word_animal",
    "05_PLACES.docx": "word_place",
    "06_ACTIONS.docx": "word_action",
    "07_OBJECTS.docx": "word_object",
    "08_HELPERS.docx": "helper",
    "09_EMOTIONS.docx": "emotion",
    "10_GOALS.docx": "goal",
    "11_PROBLEMS.docx": "problem",
    "12_REWARDS.docx": "reward",
    "13_LORE_CHARACTERS.docx": "lore_character",
    "14_LORE_PLACES.docx": "lore_place",
    "15_LORE_OBJECTS.docx": "lore_object",
    "16_CHARACTER_TRAITS.docx": "character_trait",
    "17_CHILD_ARCHETYPES.docx": "child_archetype",
    "18_DIALOG_TEMPLATES.docx": "dialog_template",
    "20_MEMORY_FACTS.docx": "memory_fact",
    "21_CONTENT_TAGS.docx": "content_tag",
    "22_GENERATION_PROMPTS.docx": "generation_prompt",
    "23_CONTENT_PIPELINES.docx": "content_pipeline",
    "24_LUMI_SYSTEM_PROMPT.docx": "system_rule",
    "26_LUMI_MEMORY_ENGINE.docx": "memory_rule",
    "27_LUMI_MODES.docx": "lumi_mode",
    "28_MASTER_CONTENT_SCHEMA.docx": "schema_rule",
    "29_LUMI_WORLD_BIBLE.docx": "world_rule",
}

LIST_DOC_TYPES = {
    "word_animal",
    "word_place",
    "word_action",
    "word_object",
    "helper",
    "emotion",
    "goal",
    "problem",
    "reward",
    "lore_character",
    "lore_place",
    "lore_object",
    "character_trait",
    "child_archetype",
    "memory_fact",
    "content_tag",
}

SECTION_HINTS = {
    "word_place",
    "word_action",
    "word_object",
    "helper",
    "emotion",
    "goal",
    "problem",
    "reward",
    "lore_character",
    "lore_place",
    "lore_object",
    "character_trait",
    "memory_fact",
    "content_tag",
}


def slug(value: str) -> str:
    value = value.lower().replace("ё", "е")
    value = re.sub(r"[^a-zа-я0-9]+", "_", value, flags=re.I)
    return re.sub(r"_+", "_", value).strip("_")[:90] or "item"


def read_lines(path: Path) -> list[str]:
    doc = Document(str(path))
    lines: list[str] = []
    for paragraph in doc.paragraphs:
        text = paragraph.text.replace("\r", "\n").replace("\v", "\n")
        for line in text.split("\n"):
            line = re.sub(r"\s+", " ", line.strip())
            if line:
                lines.append(line)
    return lines


def make_item(
    item_id: str,
    item_type: str,
    title: str,
    text: str,
    source_file: str,
    section: str = "",
    tags: list[str] | None = None,
    metadata: dict | None = None,
) -> dict:
    return {
        "id": item_id,
        "type": item_type,
        "title": title,
        "text": text,
        "lang": "ru-RU",
        "answers": [],
        "tags": tags or [],
        "source": source_file,
        "metadata": {
            "section": section,
            **(metadata or {}),
        },
    }


def is_section(line: str, item_type: str, next_line: str = "") -> bool:
    if item_type not in SECTION_HINTS:
        return False
    if re.match(r"^(age_|duration_|story$|fairytale$|riddle$|dialog$|game$|fact$)", line, re.I):
        return False
    if len(line) > 48:
        return False
    return line.isupper()


def parse_list_doc(lines: list[str], item_type: str, source_file: str) -> list[dict]:
    items: list[dict] = []
    section = ""
    content = lines[1:]

    if item_type == "child_archetype" and len(content) >= 2 and content[0].startswith("20 "):
        content = content[1:]

    for idx, line in enumerate(content):
        nxt = content[idx + 1] if idx + 1 < len(content) else ""
        if is_section(line, item_type, nxt):
            section = line
            continue
        if line == section:
            continue
        items.append(make_item(
            f"{item_type}_{slug(line)}",
            item_type,
            line,
            line,
            source_file,
            section,
            [item_type, slug(section)] if section else [item_type],
        ))
    return items


def parse_riddle_templates(lines: list[str], source_file: str) -> list[dict]:
    items: list[dict] = []
    section = ""
    i = 1
    while i < len(lines):
        line = lines[i]
        if line.startswith("БЛОК") or "RIDDLE TEMPLATES" in line or "TEMPLATE" in line:
            section = line
            i += 1
            continue
        match = re.fullmatch(r"Template\s+(\d+)", line)
        if not match:
            i += 1
            continue
        number = int(match.group(1))
        block: list[str] = []
        i += 1
        while i < len(lines) and not re.fullmatch(r"Template\s+\d+", lines[i]):
            if lines[i].startswith("БЛОК") or "RIDDLE TEMPLATES" in lines[i]:
                break
            block.append(lines[i])
            i += 1
        text = "\n".join(block).strip()
        if text:
            items.append(make_item(
                f"riddle_template_{number:03d}",
                "riddle_template",
                f"Riddle template {number:03d}",
                text,
                source_file,
                section,
                ["riddle", "template"],
                {"template_number": number},
            ))
    return items


def parse_story_templates(lines: list[str], source_file: str) -> list[dict]:
    items: list[dict] = []
    section = ""
    i = 1
    while i < len(lines):
        line = lines[i]
        if line.startswith("Категория"):
            section = line
            i += 1
            continue
        match = re.fullmatch(r"STORY_(\d+)", line)
        if not match:
            i += 1
            continue
        story_id = f"STORY_{int(match.group(1)):03d}"
        fields: dict[str, str] = {}
        block: list[str] = []
        i += 1
        while i < len(lines) and not re.fullmatch(r"STORY_\d+", lines[i]):
            if lines[i].startswith("Категория"):
                break
            block.append(lines[i])
            if ":" in lines[i]:
                key, value = lines[i].split(":", 1)
                fields[key.strip().lower()] = value.strip()
            i += 1
        items.append(make_item(
            story_id.lower(),
            "story_template",
            story_id,
            "\n".join(block),
            source_file,
            section,
            ["story", "template"],
            {"story_id": story_id, "fields": fields},
        ))
    return items


def parse_fairytale_templates(lines: list[str], source_file: str) -> list[dict]:
    items: list[dict] = []
    i = 1
    while i < len(lines):
        match = re.match(r"FAIRYTALE_(\d+)\s*(.*)", lines[i])
        if not match:
            i += 1
            continue
        number = int(match.group(1))
        title = match.group(2).strip() or f"Fairytale {number:03d}"
        block: list[str] = []
        i += 1
        while i < len(lines) and not re.match(r"FAIRYTALE_\d+", lines[i]):
            block.append(lines[i])
            i += 1
        items.append(make_item(
            f"fairytale_template_{number:03d}",
            "fairytale_template",
            title,
            "\n".join(block),
            source_file,
            "",
            ["fairytale", "template"],
            {"template_number": number},
        ))
    return items


def parse_dialog_templates(lines: list[str], source_file: str) -> list[dict]:
    items: list[dict] = []
    section = ""
    i = 1
    while i < len(lines):
        line = lines[i]
        if line.startswith("БЛОК"):
            section = line
            i += 1
            continue
        match = re.fullmatch(r"DIALOG_(\d+)", line)
        if not match:
            i += 1
            continue
        dialog_id = f"DIALOG_{int(match.group(1)):03d}"
        text = lines[i + 1] if i + 1 < len(lines) else ""
        text = re.sub(r"^Lumi:\s*", "", text).strip()
        if text:
            items.append(make_item(
                dialog_id.lower(),
                "dialog_template",
                dialog_id,
                text,
                source_file,
                section,
                ["dialog", slug(section)] if section else ["dialog"],
                {"dialog_id": dialog_id},
            ))
        i += 2
    return items


def parse_prompt_like(lines: list[str], item_type: str, source_file: str) -> list[dict]:
    items: list[dict] = []
    section = ""
    current_title = ""
    current_id = ""
    block: list[str] = []

    def flush():
        if current_id and block:
            items.append(make_item(
                current_id.lower(),
                item_type,
                current_title or current_id,
                "\n".join(block),
                source_file,
                section,
                [item_type, slug(section)] if section else [item_type],
                {"source_id": current_id},
            ))

    for line in lines[1:]:
        prompt = re.match(r"(PROMPT_\d+)\s*[—-]?\s*(.*)", line)
        mode = re.fullmatch(r"(MODE_\d+)", line)
        pipe = re.fullmatch(r"(PIPELINE_\d+)", line)
        marker = prompt or mode or pipe

        if marker:
            flush()
            current_id = marker.group(1)
            current_title = marker.group(2).strip() if prompt and prompt.lastindex and prompt.lastindex >= 2 else current_id
            block = []
            continue

        if line.isupper() and len(line) < 60 and not current_id:
            section = line
            continue
        if line.isupper() and len(line) < 60 and current_id and not block:
            current_title = line
            continue
        if current_id:
            block.append(line)
        elif line and not line.isupper():
            items.append(make_item(
                f"{item_type}_{slug(line)}",
                item_type,
                line[:80],
                line,
                source_file,
                section,
                [item_type, slug(section)] if section else [item_type],
            ))

    flush()
    return items


def parse_rule_doc(lines: list[str], item_type: str, source_file: str) -> list[dict]:
    items: list[dict] = []
    section = ""
    block: list[str] = []

    def flush():
        if section and block:
            items.append(make_item(
                f"{item_type}_{slug(section)}",
                item_type,
                section,
                "\n".join(block),
                source_file,
                section,
                [item_type],
            ))

    for line in lines[1:]:
        is_head = line.isupper() or line.startswith("ПРИНЦИП") or line.startswith("ПРАВИЛО") or line.startswith("L")
        if is_head and len(line) < 80:
            flush()
            section = line
            block = []
        else:
            block.append(line)
    flush()
    return items


def parse_doc(path: Path, item_type: str) -> list[dict]:
    lines = read_lines(path)
    if item_type == "riddle_template":
        return parse_riddle_templates(lines, path.name)
    if item_type == "story_template":
        return parse_story_templates(lines, path.name)
    if item_type == "fairytale_template":
        return parse_fairytale_templates(lines, path.name)
    if item_type == "dialog_template":
        return parse_dialog_templates(lines, path.name)
    if item_type in LIST_DOC_TYPES:
        return parse_list_doc(lines, item_type, path.name)
    if item_type in {"generation_prompt", "content_pipeline", "lumi_mode"}:
        return parse_prompt_like(lines, item_type, path.name)
    return parse_rule_doc(lines, item_type, path.name)


def dedupe_items(items: list[dict]) -> list[dict]:
    by_id: dict[str, dict] = {}
    for item in items:
        existing = by_id.get(item["id"])
        if not existing:
            by_id[item["id"]] = item
            continue
        if (
            existing.get("type") != item.get("type") or
            existing.get("text") != item.get("text")
        ):
            raise ValueError(
                f"Conflicting content id {item['id']}: "
                f"{existing.get('source')} vs {item.get('source')}"
            )
    return list(by_id.values())


def main() -> None:
    all_items: list[dict] = []
    for file_name, item_type in DOCS.items():
        path = SOURCE_DIR / file_name
        if not path.exists():
            raise FileNotFoundError(path)
        items = parse_doc(path, item_type)
        all_items.extend(items)

    all_items = dedupe_items(all_items)
    all_items.sort(key=lambda item: (item["type"], item["id"]))
    counts: dict[str, int] = {}
    for item in all_items:
        counts[item["type"]] = counts.get(item["type"], 0) + 1

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(
        json.dumps(
            {
                "version": 1,
                "source_dir": str(SOURCE_DIR),
                "counts": counts,
                "items": all_items,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"Wrote {OUT_PATH}")
    print(json.dumps(counts, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
