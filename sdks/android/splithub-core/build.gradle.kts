import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("org.jetbrains.kotlin.jvm")
    id("com.vanniktech.maven.publish")
}

java {
    sourceCompatibility = JavaVersion.VERSION_1_8
    targetCompatibility = JavaVersion.VERSION_1_8
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_1_8)
    }
}

// No runtime dependencies besides the Kotlin standard library.
dependencies {
    testImplementation("junit:junit:4.13.2")
}

tasks.test {
    // The monorepo's vectors, for runs without `node scripts/copy-vectors.mjs` first.
    systemProperty("splithub.vectors", rootProject.file("../../packages/core/test/vectors.json").absolutePath)
}

// Coordinates and POM come from gradle.properties; credentials and the signing key from ~/.gradle/gradle.properties.
mavenPublishing {
    publishToMavenCentral()
    // Unsigned without a key, so publishToMavenLocal works anywhere; Maven Central refuses unsigned uploads.
    if (providers.gradleProperty("signingInMemoryKey").isPresent || providers.gradleProperty("signing.keyId").isPresent) {
        signAllPublications()
    }
}
