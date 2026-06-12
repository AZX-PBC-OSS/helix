import "./style.css";
import { add, load, remove, save, type Note } from "./store";
import { renderNotes } from "./render";

const form = document.querySelector<HTMLFormElement>("#note-form");
const input = document.querySelector<HTMLInputElement>("#note-input");
const list = document.querySelector<HTMLUListElement>("#note-list");
const empty = document.querySelector<HTMLParagraphElement>("#empty");

if (form && input && list && empty) {
  let notes: Note[] = load();

  const update = (next: Note[]): void => {
    notes = next;
    save(notes);
    renderNotes(list, empty, notes, (id) => {
      update(remove(notes, id));
    });
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    update(add(notes, text));
    input.value = "";
    input.focus();
  });

  update(notes);
}
