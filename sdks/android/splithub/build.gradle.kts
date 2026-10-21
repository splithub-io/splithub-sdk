import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("com.vanniktech.maven.publish")
}

android {
    namespace = "io.splithub"
    compileSdk = 35

    defaultConfig {
        minSdk = 21
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_1_8)
    }
}

dependencies {
    api(project(":splithub-core"))
    implementation("androidx.lifecycle:lifecycle-process:2.6.2")
}

// Coordinates and POM come from gradle.properties; credentials and the signing key from ~/.gradle/gradle.properties.
mavenPublishing {
    publishToMavenCentral()
    // Unsigned without a key, so publishToMavenLocal works anywhere; Maven Central refuses unsigned uploads.
    if (providers.gradleProperty("signingInMemoryKey").isPresent || providers.gradleProperty("signing.keyId").isPresent) {
        signAllPublications()
    }
}
