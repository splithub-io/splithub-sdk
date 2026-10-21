package io.splithub.core

import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executor

/** Answers GETs with [overrides] (404 when null) and POSTs with the next of [statuses] (an IOException for -1). */
class FakeHttp(var overrides: String? = null, vararg statuses: Int) : HttpClient {
    val posts = CopyOnWriteArrayList<String>()
    val headers = CopyOnWriteArrayList<Map<String, String>>()
    val gets = CopyOnWriteArrayList<String>()
    private val answers = ArrayDeque(statuses.toList())
    var beforeGet: (() -> Unit)? = null

    override fun post(url: String, headers: Map<String, String>, body: String): Int {
        val status = synchronized(answers) { answers.removeFirstOrNull() } ?: 200
        if (status == -1) throw IOException("offline")
        posts.add(body)
        this.headers.add(headers)
        return status
    }

    override fun get(url: String, headers: Map<String, String>): HttpResponse {
        gets.add(url)
        beforeGet?.invoke()
        val o = overrides ?: return HttpResponse(404, "{\"error\":\"not found\"}")
        return HttpResponse(200, o)
    }

    /** Every event sent so far, parsed. */
    fun events(): List<Map<String, Any?>> = posts.flatMap { b -> Json.parse(b).asObj()!!.list("events")!!.map { it.asObj()!! } }
}

/** Runs network work inline, so tests see its effect right away. */
object DirectExecutor : Executor {
    override fun execute(command: Runnable) = command.run()
}
