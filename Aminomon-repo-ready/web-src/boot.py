"""Entry point inside the Pyodide worker: runs the chosen game on the browser curses.

AMN_GAME: amino (Aminomon adventure) | gv (Govinde Protocol) | study (study hub)
"""
import json
import os
import sys
import traceback

import js

HOME = os.path.expanduser("~")
GAME = os.environ.get("AMN_GAME", "amino")
NAMES = (".aminomon.json", ".aminomon_ajustes.json", ".aminomon_idioma", ".amino_study.json",
         ".govinde_signal.json", "GovindeCertificate.html", "GovindeCertificate.txt")
_visto = {}


def _leer(n):
    try:
        with open(os.path.join(HOME, n), encoding="utf-8") as f:
            return f.read()
    except OSError:
        return None


def guardar_si_cambio():
    for n in NAMES:
        t = _leer(n)
        if t is not None and _visto.get(n) != t:
            _visto[n] = t
            js.gvSave(n, t)


def _dedos_gordos():
    """Tap forgiveness: a touch that lands just beside a one-line button
    (a finger is wider than a text row) still presses the nearest one."""
    import curses
    import dibujo

    def _clic():
        try:
            _, mx, my, _, estado = curses.getmouse()
        except curses.error:
            return None
        if dibujo._RUEDA_ARRIBA and estado & dibujo._RUEDA_ARRIBA:
            return curses.KEY_UP
        if dibujo._RUEDA_ABAJO and estado & dibujo._RUEDA_ABAJO:
            return curses.KEY_DOWN
        if not estado & dibujo._CLIC:
            return None
        zonas = dibujo._REGIONES
        for dy, dx in ((0, 0), (0, -1), (0, 1), (-1, 0), (1, 0), (0, -2), (0, 2), (-1, -1), (-1, 1), (1, -1), (1, 1)):
            for y, x, alto, ancho, valor in reversed(zonas):
                if (dy or dx) and alto > 2:
                    continue                    # only forgive misses on small buttons
                if y <= my + dy < y + alto and x <= mx + dx < x + ancho:
                    return valor(mx, my) if callable(valor) else valor
        return None
    dibujo._clic = _clic


def _sonidos_amino():
    import ajustes
    import sonido

    def reproducir(nombre):
        notas = sonido.TONOS.get(nombre)
        if notas and ajustes.obtener("sonido"):
            js.gvSound(json.dumps({"n": nombre, "t": notas}))
    sonido.reproducir = reproducir
    sonido.disponible = lambda: True


def _sonidos_gv():
    import sound

    def play(name, pitch=0):
        if sound.ENABLED[0] and name in sound.TUNES:
            js.gvSound(json.dumps({"n": name, "t": sound.TUNES[name]}))
    sound.play = play


def correr():
    sys.path.insert(0, "/game")
    sys.argv = ["aminomon", "--sin-actualizar"] + (["--en"] if GAME == "study" else [])
    for n in NAMES:                      # what the file system already holds
        _visto[n] = _leer(n)
    import curses
    curses.set_save_hook(guardar_si_cambio)
    if GAME == "gv":
        import game as juego
        _sonidos_gv()
    elif GAME == "study":
        import study_app as juego
        _sonidos_amino()
    else:
        import aminomon as juego
        _sonidos_amino()
    _dedos_gordos()
    if GAME == "amino":                  # the daily challenge must use the player's local date, not UTC
        import datetime
        import retos
        retos.hoy = lambda: (datetime.datetime.now(datetime.timezone.utc)
                             + datetime.timedelta(minutes=int(os.environ.get("AMN_TZ_MIN", "0")))).date()
    resultado = curses.wrapper(juego.main)
    guardar_si_cambio()
    if resultado == "idioma":            # the texts are translated at import time
        js.gvRestart()
    else:
        js.gvExit()


try:
    correr()
except BaseException:  # noqa: BLE001
    js.gvFatal(traceback.format_exc())
