import type { Note } from "./store";

// Render the note list into the DOM. Text is set via textContent (never
// innerHTML) so user-entered note text can't inject markup.
export function renderNotes(
  list: HTMLUListElement,
  empty: HTMLElement,
  notes: Note[],
  onDelete: (id: string) => void,
): void {
  list.replaceChildren();
  empty.hidden = notes.length > 0;

  for (const note of notes) {
    const item = document.createElement("li");

    const text = document.createElement("span");
    text.className = "note-text";
    text.textContent = note.text;

    const del = document.createElement("button");
    del.type = "button";
    del.className = "delete";
    del.setAttribute("aria-label", "Delete note");
    del.textContent = "✕";
    del.addEventListener("click", () => {
      onDelete(note.id);
    });

    item.append(text, del);
    list.append(item);
  }
}
