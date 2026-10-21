package io.splithub.core

import java.util.Locale

/** Ports of the event-name helpers in `config.ts` and `paths.ts`. */
object Goals {
    /** Keys: lowercase letters, digits, `-` and `_`, up to 64 characters. */
    @JvmField
    val KEY_PATTERN = Regex("^[a-z0-9][a-z0-9_-]{0,63}$")

    /** Event names: letters, digits, spaces and `_ . : / -`, up to 64 characters. */
    @JvmField
    val EVENT_NAME_PATTERN = Regex("^[A-Za-z0-9][A-Za-z0-9 _.:/-]{0,63}$")

    private val NOT_KEY = Regex("[^a-z0-9_-]+")
    private val LEADING = Regex("^[^a-z0-9]+")
    private val TRAILING_DASHES = Regex("-+$")

    /** `Video Played` -> `video-played`. Empty when nothing usable is left. */
    @JvmStatic
    fun eventKey(name: String): String =
        name.trim().lowercase(Locale.ROOT)
            .replace(NOT_KEY, "-")
            .replace(LEADING, "")
            .take(64)
            .replace(TRAILING_DASHES, "")

    /** A declared goal key, the goal whose `event` is that name, or the name's slug. Null when nothing usable is left. */
    @JvmStatic
    fun goalKeyFor(goals: List<Goal>, name: String): String? {
        if (goals.any { it.key == name }) return name
        goals.firstOrNull { it.event == name }?.let { return it.key }
        val slug = eventKey(name)
        return if (KEY_PATTERN.matches(slug)) slug else null
    }

    /** `/pricing/` -> `/pricing`; the root stays `/`. */
    @JvmStatic
    fun normalizePath(path: String): String =
        if (path.length > 1 && path.endsWith("/")) path.trimEnd('/').ifEmpty { "/" } else path

    /** An exact path (trailing slash ignored) or a prefix ending with `*`. */
    @JvmStatic
    fun matchPath(pattern: String, pathname: String): Boolean =
        if (pattern.endsWith("*")) pathname.startsWith(pattern.dropLast(1)) else normalizePath(pattern) == normalizePath(pathname)
}
