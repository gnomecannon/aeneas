import { test } from "node:test";
import assert from "node:assert/strict";
import { ownWords, quoteStart, withoutSignature } from "../src/imports/mail-text.js";
import { previewOf } from "../src/mail-inbox.js";

// The quoted history and signatures mail apps write, as they write them. Every mail here is made up for this test.

test("mail quotes: the 'wrote' line in other languages", () => {
  const cases: [string, string][] = [
    ["El mar, 24 nov 2026 a las 9:12, Alex Kim (<alex@example.com>) escribió:", "Spanish"],
    ["Em ter., 24 de nov. de 2026 às 09:12, Alex Kim <alex@example.com> escreveu:", "Portuguese"],
    ["Il giorno mar 24 nov 2026 alle ore 09:12 Alex Kim <alex@example.com> ha scritto:", "Italian"],
    ["Op di 24 nov 2026 om 09:12 schreef Alex Kim <alex@example.com>:", "Dutch"],
    ["Den tis 24 nov. 2026 kl 09:12 skrev Alex Kim <alex@example.com>:", "Swedish, Norwegian, Danish"],
    ["W dniu wt., 24.11.2026 o 09:12 Alex Kim <alex@example.com> napisał(a):", "Polish"],
    ["Le mar. 24 nov. 2026 à 09:12, Alex Kim <alex@example.com> a écrit :", "French (already)"],
    ["Am Di., 24. Nov. 2026 um 09:12 Uhr schrieb Alex Kim <alex@example.com>:", "German (already)"],
  ];
  for (const [intro, lang] of cases) {
    assert.equal(ownWords(`Sí, perfecto.\n\n${intro}\n> ¿Nos vemos el sábado?`), "Sí, perfecto.", lang);
  }
  // Split over two lines, as long names make it.
  assert.equal(ownWords("Claro.\n\nEl mar, 24 nov 2026 a las 9:12, Alex Kim\n(<alex@example.com>) escribió:\n> Hola"), "Claro.");
});

test("mail quotes: Outlook's ways", () => {
  assert.equal(ownWords("Approved.\n\n________________________________\nFrom: Alex Kim <alex@example.com>\nSent: Tuesday, November 24, 2026 9:12 AM\nTo: Robin"), "Approved.", "the long line above the block");
  assert.equal(ownWords("Approved.\n\n________________________________\nDe : Alex Kim\nEnvoyé : mardi 24 novembre 2026 09:12"), "Approved.", "the line, in another language");
  assert.equal(ownWords("See below.\n\nFrom: Alex Kim <alex@example.com>\nTo: Robin <robin@example.com>\nSubject: Gutters"), "See below.", "From, then To and Subject");
  assert.equal(ownWords("See below.\n\n*From:* Alex Kim <alex@example.com>\n*Sent:* Tuesday, November 24, 2026 9:12 AM"), "See below.", "bold headers as text");
  assert.equal(ownWords("See below.\n\nFrom: Alex Kim\nSent: Tuesday, November 24, 2026 9:12 AM\nTo: Robin\nSubject: Gutters"), "See below.", "no address, the whole block");
  assert.equal(ownWords("Voir ci-dessous.\n\nDe : Alex Kim\nEnvoyé : mardi 24 novembre 2026 09:12\nÀ : Robin\nObjet : Gouttières"), "Voir ci-dessous.", "in another language");
  assert.equal(ownWords("Ok.\n\n-----Ursprüngliche Nachricht-----\nVon: Alex"), "Ok.");
  assert.equal(ownWords("Ok.\n\n-----Message d'origine-----\nDe : Alex"), "Ok.");
  assert.equal(ownWords("Ok.\n\n----- Mensaje original -----\nDe: Alex"), "Ok.");
  assert.equal(ownWords("Ok.\n\n-------- Original message --------\nFrom: Alex"), "Ok.", "Android's");
});

test("mail quotes: what is not quoted history stays", () => {
  for (const text of [
    "From: the desk of Robin\nThanks for coming!",
    // A transfer notice's own facts, which start like a mail's head.
    "Your transfer is complete.\n\nFrom: Checking 1234\nTo: Savings 5678\nAmount: $500.00",
    "Your transfer is complete.\n\nFrom: Checking 1234\nTo: Savings 5678\nDate: November 20, 2026\nAmount: $500.00",
    "Trip booked.\n\nFrom: Boston\nTo: Denver\nDate: December 3",
    "On Monday I wrote the report.\nIt is attached.",
    "The minutes, as the chair wrote:\nwe meet Saturday.",
    "Elsewhere el sábado escribió algo.",
    "________________________________\nJust a line of underscores.",
  ]) assert.equal(quoteStart(text), -1, text);
});

test("mail quotes: phone and mail-app signatures leave previews, not the mail", () => {
  for (const sig of ["Sent from my iPhone", "Sent from my iPad", "Sent from my Android phone", "Get Outlook for iOS", "Get Outlook for Android", "Sent from Mail for Windows", "Sent from Yahoo Mail for iPhone", "Sent from my Pixel", "Enviado desde mi iPhone", "Envoyé de mon iPhone", "Von meinem iPhone gesendet"]) {
    assert.equal(withoutSignature(`See you at 10.\n\n${sig}`), "See you at 10.", sig);
  }
  assert.equal(withoutSignature("See you at 10.\n\n-- \nRobin Lee\nGardener"), "See you at 10.", "the standard '-- ' line");
  assert.equal(withoutSignature("Sent from my iPhone"), "Sent from my iPhone", "nothing else: kept");
  assert.equal(withoutSignature("I sent from my iPhone the photos.\nMore later."), "I sent from my iPhone the photos.\nMore later.", "only a line of its own");
  assert.equal(previewOf("See you at 10.\n\nSent from my iPhone\n\nOn Tue, Nov 24, 2026 at 9:12 AM Alex <alex@example.com> wrote:\n> Saturday?"), "See you at 10.");
});
