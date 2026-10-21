pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "splithub-android"

// splithub-core: plain JVM (hash, assignment, targeting, overrides, JSON, queue, client), tested without Android.
// splithub: the Android library apps install (storage, lifecycle, device info) on top of it.
// splithub-compose: optional Jetpack Compose helpers.
include(":splithub-core", ":splithub", ":splithub-compose")
