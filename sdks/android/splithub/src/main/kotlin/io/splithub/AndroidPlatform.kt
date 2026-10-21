package io.splithub

import android.content.Context
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import io.splithub.core.AppInfo
import io.splithub.core.KeyValueStorage
import io.splithub.core.SplitHubClient
import io.splithub.core.SplitHubLogger
import io.splithub.core.TargetingContext
import java.util.Locale
import java.util.TimeZone

/** SharedPreferences as the SDK's storage: visitor id, user id, cached overrides, the offline queue. */
internal class SharedPreferencesStorage(context: Context) : KeyValueStorage {
    private val prefs: SharedPreferences = context.getSharedPreferences("io.splithub", Context.MODE_PRIVATE)

    override fun getItem(key: String): String? = prefs.getString(key, null)

    override fun setItem(key: String, value: String) {
        prefs.edit().putString(key, value).apply()
    }

    override fun removeItem(key: String) {
        prefs.edit().remove(key).apply()
    }
}

internal object AndroidPlatform {
    val mainHandler = Handler(Looper.getMainLooper())

    /** The `app` block of every batch. */
    fun appInfo(context: Context): AppInfo {
        var versionName: String? = null
        var versionCode: String? = null
        try {
            val info = context.packageManager.getPackageInfo(context.packageName, 0)
            versionName = info.versionName
            versionCode = if (Build.VERSION.SDK_INT >= 28) {
                info.longVersionCode.toString()
            } else {
                @Suppress("DEPRECATION")
                info.versionCode.toString()
            }
        } catch (e: PackageManager.NameNotFoundException) {
            // our own package is always there; nothing to report otherwise
        }
        return AppInfo(
            platform = "android",
            id = context.packageName,
            version = versionName,
            build = versionCode,
            os = Build.VERSION.RELEASE,
            model = Build.MODEL,
            device = device(context),
        )
    }

    /** `tablet` from 600 dp on the shortest side, like the platform's own resource qualifier `sw600dp`. */
    fun device(context: Context): String =
        if (context.resources.configuration.smallestScreenWidthDp >= 600) "tablet" else "mobile"

    /** What targeting conditions can read on the device. The cloud adds country, region and city. */
    fun targetingContext(app: AppInfo): TargetingContext = TargetingContext(
        platform = "android",
        appVersion = app.version,
        language = Locale.getDefault().toLanguageTag(),
        timezone = TimeZone.getDefault().id,
        device = app.device,
        os = "android",
    )

    fun logger(debug: Boolean): SplitHubLogger = object : SplitHubLogger {
        override fun warn(message: String) {
            Log.w("SplitHub", message)
        }

        override fun debug(message: String) {
            if (debug) Log.d("SplitHub", message)
        }
    }

    /** Foreground and background of the whole app (not one activity): a session ends 30 minutes after the last screen closes. */
    fun observeLifecycle(client: SplitHubClient) {
        val register = Runnable {
            ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
                override fun onStart(owner: LifecycleOwner) {
                    client.onForeground()
                }

                override fun onStop(owner: LifecycleOwner) {
                    client.onBackground()
                }
            })
        }
        if (Looper.myLooper() == Looper.getMainLooper()) register.run() else mainHandler.post(register)
    }
}

internal fun sdkName(): String = "android/${SplitHubClient.VERSION}"

