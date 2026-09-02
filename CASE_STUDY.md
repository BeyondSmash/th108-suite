# Engineering case study — TH108 Lighting Suite

There is no public per-key lighting API for this keyboard. Everything here started as a
black box: raw USB packets, an undocumented protocol, and hardware that fights back —
muting itself, resetting its own effects, and dropping keystrokes under load.

This page documents the engineering that came out of that: seven real faults, each traced
to a root cause and fixed rather than patched over.

| | |
|---|---|
| **Commits** | 927 |
| **Build window** | 7 Jun – 31 Aug 2026 (3 months, solo) |
| **Tests** | 249 passing, 0 failing — 816 assertions across 21 files |
| **Source** | 12,601 lines of JS across 33 files |
| **Frameworks** | none — vanilla JS, no build step, no browser production dependencies |

Run the suite yourself with `node --test` in `app/` and `th108-daemon/`.

---

## 1. The keyboard that mutes itself

**Symptom.** The lighting pipe wedges and stops accepting frames — sometimes seconds after a
keystroke, sometimes on wake, sometimes only while a game or capture app is running.

**Root cause.** Not one bug but a family of them: USB bandwidth contention, the OS
re-enumerating the device mid-keystroke, and other software (Steam Input, for one) probing
the shared HID channel and desyncing it.

**Fix.** A staged recovery ladder — retry, then a forced USB re-enumeration, then heavier
resets — gated on a keypress lull so it never fires mid-typing, with held keys tracked so
none stick.

## 2. The false acknowledgement

**Symptom.** Writes to the board would intermittently freeze the whole lighting stream.

**Root cause.** Each write waits for the board to confirm before the next is sent. The board
*also* emits unsolicited status messages, and those were falsely satisfying that
confirmation, so the sender advanced out of sync.

**Fix.** Distinguish a real acknowledgement from a coincidental one by matching the *echoed
byte offset* of the write — a one-line discriminator, findable only by reading the raw
packet stream.

## 3. Reverse-engineering the lighting protocol

**Goal.** Paint any color on any individual key from a web page.

**Dead end.** The obvious HTTP endpoint the board exposes turned out to be read-only for
colors — a decoy.

**Result.** The real path is a full-frame WebHID paint command bound to the correct hardware
interface. That single discovery is what makes the entire suite possible.

## 4. Two programs, one keyboard

**Symptom.** When both the web page and the always-on daemon tried to drive the board, they
collided and the lighting froze.

**Root cause.** The hardware tolerates exactly one writer at a time.

**Fix.** A shared lighting engine used by both, plus an explicit hand-off protocol — whoever
is driving cleanly yields control to the other. That is why lighting survives closing the tab.

## 5. The rainbow that wouldn't die

**Symptom.** A firmware rainbow flashed across the board during any restart or recovery gap.

**Root cause.** The board's built-in effect silently re-arms itself every time the device
re-enumerates over USB.

**Fix.** Re-assert a black mask on every fresh connection, tied to the re-enumeration event,
so the stock effect never gets a window to show.

## 6. Stuck keys after wake and under load

**Symptom.** In some games keys would stick — both lit, and worse, stuck *down* as input —
after sleep/wake or heavy activity.

**Root cause.** The global key hook dropped release events when the device re-enumerated
mid-keystroke, and animation clocks jumped after wake from an unclamped time delta.

**Fix.** Track held keys and release them on focus loss, clamp the frame delta so clocks
can't leap on wake, and gate risky recovery on a typing lull.

A lighting tool must never break the keyboard it lights.

## 7. Disproving the obvious culprit

**Symptom.** An audio device muted on every sleep/wake, and the keyboard was the prime
suspect — it shares a USB controller.

**Root cause.** The keyboard, the daemon, and the shared-USB theory were each disproved in
turn. The real fault was a Windows audio-stack resume regression, unrelated to this project.

**Fix.** A small wake-time service restart — and, more usefully, the evidence that stopped
the wrong component from being blamed.

## 8. Auditing my own project, and finding real problems

**Symptom.** The suite was publicly accused of being a keylogger. Three of the four specific
claims did not survive contact with the code — but "we checked and we're fine" is exactly what
a compromised project would say, so the project was put through two independent adversarial
security audits with an explicit instruction to assume the previous review had blind spots.

**Root cause.** The audits agreed, and they found things the accusation had missed entirely.
The worst was not the keyboard hook at all: a recovery task ran with administrator rights, but
its payload sat in the project folder, which any program running as the logged-in user can
overwrite. That turns a convenience feature into a way for ordinary software to gain
administrator access without a prompt. Second was a debug log that recorded window titles —
and a code-editor window puts the filename you have open, and the sentence you are mid-way
through typing, in its title. So a project promising it stored nothing you typed was, in one
narrow path, storing fragments of it. Third, the page loaded its two fonts from Google, which
contacted a third party on every single page load while the documentation claimed there was no
remote endpoint.

**Fix.** The elevated task's payload moved to an administrator-only directory — a pattern this
project already used elsewhere and had failed to apply consistently. Window titles were removed
from every log, the log was capped, and the leftover debug probe behind it was deleted. The
fonts were self-hosted, making the "no remote endpoint" claim literally true. The localhost
server's cross-origin guard was extended from POST-only to every method (a plain image tag on
any web page could previously pop a native file dialog), and it now serves only the web app
rather than the whole project folder. The browser device pre-grant was narrowed from an entire
vendor to this one keyboard. Dependencies were pinned to exact versions. And the documentation
was corrected where it had been generous with itself.

**Then the critic came back, and was right again.** The browser pre-grant that had been "narrowed"
was still wrong in kind, not just in scope: that kind of grant is given to a web address, not to a
program, and nothing reserves the address it named. Any ordinary program that got to the port first
could have claimed it and inherited silent access to the keyboard. It is no longer installed, and
upgrading removes it from machines that already had it. The same reply pointed out that "it reads key
codes, not characters" is not the privacy claim it sounds like, since a key code plus your keyboard
layout is the character. That wording is gone from the documentation, and the hook itself now has an
off switch: turn it off and nothing in the process sees a key press, at the cost of reactive typing
effects and hotkeys.

**Third round: the same bug, one level deeper.** Reviewing the project again in the critic's voice —
assuming the reply would be picked apart in public — turned up that the privilege-escalation fix above
was incomplete. Moving the elevated task's payload into an administrator-only folder stopped anyone from
swapping *the file*. It did nothing about what the file calls. That payload asks Windows PowerShell to
find the keyboard's USB device, and PowerShell looks up a command like that by searching a list of
folders — the first of which is inside the user's own Documents, writable by any program running as that
user. So instead of replacing the protected file, ordinary software could leave a fake version of that
one command where PowerShell looks first, trigger the recovery task (which by design needs no prompt),
and run its own code as administrator. Demonstrated with a harmless stand-in, which won the lookup on
the first try. The fix pins the search to Windows' own folder, so only the real command can answer;
verified by re-running both versions with the stand-in in place — the old one returned the fake, the new
one returned the actual keyboard. The same review found that the install could stop running package
install scripts entirely, which had been assumed impossible because two packages declare them: they
turn out to ship their compiled binary in the package and locate it themselves, so the install now
skips all package scripts at no cost.

The interesting part is not that a hobby project had security bugs. It is where the real ones came
from. The original accusation was wrong on its specifics and right that the project deserved a look;
the audits found three serious problems it had not mentioned; the sharpest single finding came
from the accuser, in public, after the project had already declared itself clean; and the round after
that found the first big fix had only moved the problem. Being audited is not a thing you finish.

**What changed in the process, not just the code.** Three rounds of "does it work" testing over a month
never asked the question that found all three holes: *what can somebody else's program on this machine make
this do?* That is a different question from testing, and nobody had been assigned to ask it. So it is now a
standing rule for this and every future project: the moment a project gains anything that runs as
administrator, anything machine-wide or persistent, an open port, code that runs during install, or input
capture, that fact is stated out loud and an attack-style review runs before the work is called done. The
elevated batch file also now ships with its own check, a script that mirrors its device lookup line and
prints what it resolves to, because that one line had silently found nothing twice. It is one check, not a
test suite for the install glue, which remains untested; the case study says so because the critic was
right to point it out.

---

## What this demonstrates

- **Reverse engineering** — recovered an undocumented USB HID protocol from raw traffic, with no SDK or reference.
- **Low-level debugging** — traced faults across the hardware, USB, OS and browser boundaries to real root causes.
- **Concurrency** — a single-writer hardware resource shared safely between a web page and a background service.
- **Test discipline** — 252 unit tests on the standard Node runner, no framework required.
- **Privacy-first design** — local-only; the keyboard hook can be switched off entirely, nothing typed is stored or transmitted, and the daemon makes no outbound requests at all. The page loads no third-party resources. The localhost server is hardened against DNS-rebinding and cross-origin requests on every method. See [Privacy & the keyboard hook](README.md#privacy--the-keyboard-hook).
- **Taking criticism seriously** — commissioned adversarial security audits after a public accusation, fixed what they found (including a privilege-escalation hole nobody had spotted), then kept fixing when the critic landed a further hit the audits had missed (section 8).
- **Sustained solo delivery** — 938 commits over three months, in public, including a month of pure polish and hardware testing.

## Stack

WebHID for direct device access · vanilla JS for a zero-framework UI · Canvas and WebGL for
the lighting compositor · Node for the always-on daemon · `node-hid` for native HID
transport · a localhost server hardened against DNS-rebinding · `node --test` for the suite.
