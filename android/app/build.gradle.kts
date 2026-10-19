import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
}

// One version for every platform: the one in the repository's package.json.
// Read through providers.fileContents, so the configuration cache sees a
// changed version.
val packageJson = providers.fileContents(rootProject.layout.projectDirectory.file("../package.json")).asText.get()
@Suppress("UNCHECKED_CAST")
val appVersion = (JsonSlurper().parseText(packageJson) as Map<String, Any>)["version"] as String
val versionParts = appVersion.split(".").map { part -> part.takeWhile { it.isDigit() }.toInt() }
require(versionParts.size == 3 && versionParts[1] < 100 && versionParts[2] < 100) { "unexpected version $appVersion" }

// hev-socks5-tunnel, fetched and checked by scripts/fetch-hev.js; checked
// again before every build (verifyHev below).
val hevDir = File(rootProject.projectDir, "third_party/hev-socks5-tunnel")
if (!File(hevDir, "Android.mk").isFile) {
    throw GradleException("hev-socks5-tunnel is missing: run `node android/scripts/fetch-hev.js` first")
}

val abis = listOf("arm64-v8a", "armeabi-v7a", "x86_64")

// Release signing comes from the environment (CI); nothing secret is in the repository.
val keystorePath = providers.environmentVariable("ANDROID_KEYSTORE").orNull
val releaseSigned = !keystorePath.isNullOrBlank()

android {
    namespace = "me.codeshare.shroudly"
    compileSdk = 36
    ndkVersion = "28.2.13676358"

    defaultConfig {
        applicationId = "me.codeshare.shroudly"
        minSdk = 26
        targetSdk = 36
        versionCode = versionParts[0] * 10000 + versionParts[1] * 100 + versionParts[2]
        versionName = appVersion

        ndk { abiFilters += abis }
        externalNativeBuild {
            ndkBuild {
                targets += "hev-socks5-tunnel"
                // The JNI class the library registers its natives on (see Tun2Socks.kt).
                cFlags += listOf("-DPKGNAME=me/codeshare/shroudly", "-DCLSNAME=Tun2Socks")
                arguments += listOf("APP_SUPPORT_FLEXIBLE_PAGE_SIZES=true")
            }
        }
    }

    externalNativeBuild {
        ndkBuild { path = File(hevDir, "Android.mk") }
    }

    signingConfigs {
        if (releaseSigned) {
            create("release") {
                storeFile = file(keystorePath!!)
                storePassword = providers.environmentVariable("ANDROID_KEYSTORE_PASSWORD").orNull
                keyAlias = providers.environmentVariable("ANDROID_KEY_ALIAS").orNull
                keyPassword = providers.environmentVariable("ANDROID_KEY_PASSWORD").orNull
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Without the variables the release APK is left unsigned.
            if (releaseSigned) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures { buildConfig = true }

    // The engine is an executable shipped as lib*.so: it has to be extracted
    // to nativeLibraryDir to be run.
    packaging { jniLibs { useLegacyPackaging = true } }

    lint {
        // Translations come from locales/*.json and are checked there.
        disable += listOf("MissingTranslation", "ExtraTranslation")
        abortOnError = true
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
}

// The engine (libshroudlycore.so) is built from core/ by scripts/build-core-android.js.
// A release without it for every ABI would install and then do nothing.
val checkEngine = tasks.register("checkEngine") {
    val dir = layout.projectDirectory.dir("src/main/jniLibs")
    val wanted = abis
    doLast {
        val missing = wanted.filter { !dir.file("$it/libshroudlycore.so").asFile.isFile }
        if (missing.isNotEmpty()) {
            throw GradleException("engine missing for ${missing.joinToString()}: run `node scripts/build-core-android.js`")
        }
    }
}

// The hev tree that is built must be the pinned one, file for file: a tree
// accepted with SHROUDLY_HEV_TRUST=1, edited, or restored from a cache stops
// the build. Hashing it takes well under a second.
val verifyHev = tasks.register<Exec>("verifyHev") {
    workingDir = rootProject.projectDir
    commandLine("node", "scripts/fetch-hev.js", "--verify")
}

tasks.configureEach {
    if (name == "preReleaseBuild") dependsOn(checkEngine)
    if (name == "preBuild" || name.startsWith("configureNdkBuild") || name.startsWith("buildNdkBuild")) dependsOn(verifyHev)
}
