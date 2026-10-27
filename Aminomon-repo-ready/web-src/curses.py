"""Minimal `curses` replacement for running terminal games in a browser tab.

It runs inside a Pyodide web worker. The screen is a grid of cells; refresh()
sends the rows that changed to the page (which draws them on a <canvas>).
Input arrives through a SharedArrayBuffer ring buffer filled by the page; the
blocking calls (get_wch, napms) wait with Atomics.wait inside JS helpers that
worker.js exposes as globals (see worker.js).

Only the part of curses that Aminomon uses is implemented (plus harmless
no-ops for the rest), with the same signatures and exceptions.
"""

import json
import time

import js  # Pyodide: the worker's global scope


class error(Exception):
    pass


# ---------------------------------------------------------------- constants
COLOR_BLACK, COLOR_RED, COLOR_GREEN, COLOR_YELLOW = 0, 1, 2, 3
COLOR_BLUE, COLOR_MAGENTA, COLOR_CYAN, COLOR_WHITE = 4, 5, 6, 7
COLORS = 256
COLOR_PAIRS = 4096

A_NORMAL = 0
A_COLOR = 0xFFFF00
A_BOLD = 1 << 24
A_DIM = 1 << 25
A_REVERSE = 1 << 26
A_UNDERLINE = 1 << 27
A_BLINK = 1 << 28
A_STANDOUT = A_REVERSE | A_BOLD
A_ATTRIBUTES = ~0xFF

KEY_DOWN, KEY_UP, KEY_LEFT, KEY_RIGHT = 258, 259, 260, 261
KEY_HOME, KEY_BACKSPACE, KEY_DC = 262, 263, 330
KEY_NPAGE, KEY_PPAGE, KEY_ENTER = 338, 339, 343
KEY_END = 360
KEY_MOUSE, KEY_RESIZE = 409, 410

BUTTON1_RELEASED, BUTTON1_PRESSED, BUTTON1_CLICKED = 1, 2, 4
BUTTON1_DOUBLE_CLICKED, BUTTON1_TRIPLE_CLICKED = 8, 16
BUTTON4_PRESSED = 1 << 16
BUTTON5_PRESSED = 1 << 21
ALL_MOUSE_EVENTS = 0x7FFFFFF

# event types written by app.js into the ring buffer
_EV_KEY, _EV_MOUSE, _EV_RESIZE, _EV_SPECIAL = 1, 2, 3, 4
_MOUSE_BSTATE = {1: BUTTON1_CLICKED, 4: BUTTON4_PRESSED, 5: BUTTON5_PRESSED}


def color_pair(n):
    return (n & 0xFFFF) << 8


def pair_number(attr):
    return (attr & A_COLOR) >> 8


# ------------------------------------------------------------------- state
_pairs = {0: (-1, -1)}
_mouse_on = False
_unget = []
_last_mouse = None
_stdscr = None
_last_save_check = 0.0
_save_hook = None        # set by boot.py: called now and then to persist saves


def set_save_hook(fn):
    global _save_hook
    _save_hook = fn


def _tick_hook(force=False):
    global _last_save_check
    now = time.monotonic()
    if _save_hook and (force or now - _last_save_check > 1.0):
        _last_save_check = now
        try:
            _save_hook()
        except Exception:  # noqa: BLE001
            pass


_prof = {"refresh": 0.0, "n": 0, "game": 0.0, "last_in": 0.0}


def _wait_event(ms):
    """Next input event as (type, a, b, c), or None after ms (-1: forever)."""
    if ms < 0:
        while True:
            _tick_hook(True)
            if _prof["n"] and _prof["n"] % 1 == 0 and getattr(js, "gvProf", None):
                js.gvProf(json.dumps(_prof))
            r = js.gvWait(1000)
            if r:
                break
    else:
        r = js.gvWait(ms)
        if not r:
            return None
    return tuple(int(v) for v in str(r).split(","))


class Window:
    def __init__(self):
        self._rows, self._cols = 24, 80
        self._ch = []
        self._at = []
        self._sent_ch = []
        self._sent_at = []
        self._cy = self._cx = 0
        self._timeout = -1
        self._full = True
        self._resize_to(*self._js_size())

    # --- geometry
    @staticmethod
    def _js_size():
        return int(js.gvRows()), int(js.gvCols())

    def _resize_to(self, rows, cols):
        rows, cols = max(1, rows), max(1, cols)
        self._rows, self._cols = rows, cols
        self._ch = [[" "] * cols for _ in range(rows)]
        self._at = [[0] * cols for _ in range(rows)]
        self._sent_ch, self._sent_at = [], []
        self._full = True
        self._cy = min(self._cy, rows - 1)
        self._cx = min(self._cx, cols - 1)

    def _check_size(self):
        rows, cols = self._js_size()
        if (rows, cols) != (self._rows, self._cols):
            self._resize_to(rows, cols)

    def getmaxyx(self):
        self._check_size()
        return self._rows, self._cols

    def getyx(self):
        return self._cy, self._cx

    def move(self, y, x):
        self._cy, self._cx = y, x

    # --- drawing
    def addstr(self, *args):
        args = list(args)
        if len(args) >= 3 and isinstance(args[0], int) and isinstance(args[1], int):
            y, x = args[0], args[1]
            args = args[2:]
        else:
            y, x = self._cy, self._cx
        text = args[0]
        attr = args[1] if len(args) > 1 else 0
        self._put(y, x, str(text), attr)

    def addch(self, *args):
        args = list(args)
        if len(args) >= 3 and isinstance(args[0], int) and isinstance(args[1], int):
            y, x = args[0], args[1]
            args = args[2:]
        else:
            y, x = self._cy, self._cx
        ch = args[0]
        attr = args[1] if len(args) > 1 else 0
        self._put(y, x, ch if isinstance(ch, str) else chr(ch), attr)

    def _put(self, y, x, text, attr):
        if not (0 <= y < self._rows and 0 <= x < self._cols):
            raise error("addwstr() returned ERR")
        row_c, row_a = self._ch[y], self._at[y]
        cols = self._cols
        for ch in text:
            if ch == "\n":
                y += 1
                x = 0
                if y >= self._rows:
                    raise error("addwstr() returned ERR")
                row_c, row_a = self._ch[y], self._at[y]
                continue
            if x >= cols:                       # wrap like curses does
                y += 1
                x = 0
                if y >= self._rows:
                    raise error("addwstr() returned ERR")
                row_c, row_a = self._ch[y], self._at[y]
            row_c[x] = ch
            row_a[x] = attr
            x += 1
        self._cy, self._cx = y, min(x, cols - 1) if x >= cols else x

    def erase(self):
        for y in range(self._rows):
            self._ch[y] = [" "] * self._cols
            self._at[y] = [0] * self._cols
        self._cy = self._cx = 0

    def clear(self):
        self.erase()
        self._full = True

    def clrtoeol(self):
        y, x = self._cy, self._cx
        for i in range(x, self._cols):
            self._ch[y][i] = " "
            self._at[y][i] = 0

    def redrawln(self, *a):
        self._full = True

    def redrawwin(self):
        self._full = True

    # --- output
    def refresh(self, *a):
        _t0 = time.perf_counter()
        if _prof["last_in"]:
            _prof["game"] += _t0 - _prof["last_in"]
            _prof["last_in"] = 0.0
        self._check_size()
        rows = []
        full = self._full or len(self._sent_ch) != self._rows
        if full:
            self._sent_ch = [None] * self._rows
            self._sent_at = [None] * self._rows
            self._full = False
        for y in range(self._rows):
            c, a = self._ch[y], self._at[y]
            if c == self._sent_ch[y] and a == self._sent_at[y]:
                continue
            self._sent_ch[y] = list(c)
            self._sent_at[y] = list(a)
            rows.append([y, "".join(c), _runs(a)])
        if rows or full:
            js.gvDraw(json.dumps({"rows": self._rows, "cols": self._cols,
                                  "full": full, "r": rows}, separators=(",", ":")))
        _prof["refresh"] += time.perf_counter() - _t0
        _prof["n"] += 1
        _tick_hook()

    noutrefresh = refresh

    # --- input
    def nodelay(self, flag):
        self._timeout = 0 if flag else -1

    def timeout(self, ms):
        self._timeout = ms

    def keypad(self, flag):
        pass

    def get_wch(self):
        k = self._read()
        if k is None:
            raise error("no input")
        return k

    def getch(self):
        k = self._read()
        if k is None:
            return -1
        return ord(k) if isinstance(k, str) else k

    def _read(self):
        global _last_mouse
        deadline = None if self._timeout < 0 else time.monotonic() + self._timeout / 1000
        while True:
            if _unget:
                return _unget.pop(0)
            if deadline is None:
                ev = _wait_event(-1)
            else:
                left = int(max(0, (deadline - time.monotonic()) * 1000))
                ev = _wait_event(left)
                if ev is None:
                    return None
            kind, a, b, c = ev
            _prof["last_in"] = time.perf_counter()
            if kind == _EV_KEY:
                return chr(a)
            if kind == _EV_SPECIAL:
                return a
            if kind == _EV_MOUSE:
                if not _mouse_on:
                    if deadline is not None and time.monotonic() >= deadline:
                        return None
                    continue
                _last_mouse = (0, a, b, 0, _MOUSE_BSTATE.get(c, BUTTON1_CLICKED))
                return KEY_MOUSE
            if kind == _EV_RESIZE:
                self._check_size()
                return KEY_RESIZE

    # --- harmless no-ops
    def idlok(self, *a): pass
    def idcok(self, *a): pass
    def leaveok(self, *a): pass
    def scrollok(self, *a): pass
    def immedok(self, *a): pass
    def notimeout(self, *a): pass
    def clearok(self, *a): pass
    def touchwin(self): pass
    def bkgd(self, *a): pass
    def bkgdset(self, *a): pass
    def attron(self, *a): pass
    def attroff(self, *a): pass
    def attrset(self, *a): pass


def _runs(attrs):
    """[[x, n, fg, bg, flags], ...] with colours as xterm-256 indices (-1 = default)."""
    out = []
    prev = None
    start = 0
    for x, a in enumerate(attrs):
        if a != prev:
            if prev is not None:
                out.append(_run(start, x - start, prev))
            prev, start = a, x
    if prev is not None:
        out.append(_run(start, len(attrs) - start, prev))
    return out


def _run(x, n, a):
    fg, bg = _pairs.get((a & A_COLOR) >> 8, (-1, -1))
    flags = ((1 if a & A_BOLD else 0) | (2 if a & A_DIM else 0) |
             (4 if a & A_UNDERLINE else 0) | (8 if a & A_REVERSE else 0))
    return [x, n, fg, bg, flags]


# ---------------------------------------------------------------- module API
def initscr():
    global _stdscr
    if _stdscr is None:
        _stdscr = Window()
    return _stdscr


def endwin():
    pass


def isendwin():
    return False


def wrapper(func, *args, **kwargs):
    scr = initscr()
    try:
        return func(scr, *args, **kwargs)
    finally:
        endwin()


def start_color(): pass
def use_default_colors(): pass
def has_colors(): return True
def can_change_color(): return False
def noecho(): pass
def echo(): pass
def cbreak(): pass
def nocbreak(): pass
def raw(): pass
def noraw(): pass
def nl(): pass
def nonl(): pass
def beep(): pass
def flash(): pass
def doupdate(): pass
def set_escdelay(ms): pass
def meta(flag): pass
def napms_noop(ms): pass


def curs_set(v):
    return 1


def init_pair(n, fg, bg):
    _pairs[n] = (fg, bg)


def init_color(*a):
    raise error("init_color() returned ERR")


def mousemask(mask):
    global _mouse_on
    _mouse_on = bool(mask)
    return (ALL_MOUSE_EVENTS if mask else 0, 0)


def mouseinterval(ms):
    return 0


def getmouse():
    if _last_mouse is None:
        raise error("getmouse() returned ERR")
    return _last_mouse


def profile():
    return json.dumps(_prof)


def napms(ms):
    _tick_hook()
    js.gvSleep(int(ms))
    return 0


def flushinp():
    del _unget[:]
    js.gvFlush()


def ungetch(k):
    _unget.append(chr(k) if isinstance(k, int) and k < 256 else k)


def unget_wch(k):
    _unget.append(k)


def resize_term(*a):
    pass


def update_lines_cols():
    pass


def newwin(*a):
    raise error("newwin is not supported")


def setupterm(*a, **k):
    pass


def tigetstr(*a):
    return None


def tigetnum(*a):
    return -1
