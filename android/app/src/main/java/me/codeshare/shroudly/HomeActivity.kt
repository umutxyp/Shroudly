package me.codeshare.shroudly

/*
 * The main window, as the system starts it. Everything is MainActivity's;
 * this class exists so that the launcher's entries can be activity aliases
 * (Logos): the classic logo's alias keeps the name ".MainActivity" that
 * every launcher has pinned since the first version, so choosing nothing
 * changes nothing on anyone's home screen, and an alias for another logo can
 * take its place. Code that opens the window names this class, never the
 * alias: an alias that is turned off cannot be started.
 */
class HomeActivity : MainActivity()
