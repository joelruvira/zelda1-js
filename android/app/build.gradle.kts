import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release signing: a LOCAL keystore, never in git (android/keystore/, see docs/ANDROID.md).
// scripts/android/keystore.mjs creates it the first time `npm run android:build` runs.
val keystoreDir = rootProject.file("keystore")
val keystoreProps = Properties().apply {
    val f = File(keystoreDir, "keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
val hasReleaseKey = keystoreProps.getProperty("storeFile")?.let { File(keystoreDir, it).exists() } == true

// The web app (src/ + android/web/) is copied into the assets on every build: never duplicated in git.
val repoRoot = rootProject.projectDir.parentFile
val copyWebAssets by tasks.registering(Exec::class) {
    description = "Copies the web game (src/, android/web/) into the APK assets (scripts/android/copy-web.mjs)."
    workingDir = repoRoot
    commandLine("node", "scripts/android/copy-web.mjs")
    inputs.dir(File(repoRoot, "src"))
    inputs.dir(File(repoRoot, "android/web"))
    inputs.dir(File(repoRoot, "tests/oracle/movies"))
    inputs.file(File(repoRoot, "scripts/android/copy-web.mjs"))
    outputs.dir(file("src/main/assets/www"))
    outputs.dir(file("src/debug/assets/www"))
}
// The player's ROM (roms/zelda.nes, validated as US PRG0) goes into the APK so the app never asks for it.
// It is written only to a git-ignored build folder (scripts/android/rom-asset.mjs); the build fails with a
// clear message when it is missing or is not the right ROM. The resulting APK is for personal use only.
val romAssetsDir = layout.buildDirectory.dir("generated/zelda-rom/assets")
val packRom by tasks.registering(Exec::class) {
    description = "Validates roms/zelda.nes (US PRG0) and packs it into the APK assets (scripts/android/rom-asset.mjs)."
    workingDir = repoRoot
    commandLine("node", "scripts/android/rom-asset.mjs", "--quiet")
    inputs.dir(File(repoRoot, "roms"))
    inputs.file(File(repoRoot, "scripts/android/rom-asset.mjs"))
    inputs.file(File(repoRoot, "android/web/romcheck.js"))
    outputs.dir(romAssetsDir)
}
tasks.named("preBuild") { dependsOn(copyWebAssets, packRom) }

android {
    namespace = "io.github.joelruvira.zelda1js"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.github.joelruvira.zelda1js"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
    }

    signingConfigs {
        if (hasReleaseKey) {
            create("release") {
                storeFile = File(keystoreDir, keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = if (hasReleaseKey) signingConfigs.getByName("release") else null
            vcsInfo.include = false
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    dependenciesInfo {
        includeInApk = false
        includeInBundle = false
    }

    sourceSets.getByName("main").assets.srcDir(romAssetsDir)

    androidResources {
        // keep the web files exactly as they are (no compression of already small text, no filtering)
        ignoreAssetsPattern = "!.DS_Store:!*.map"
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.activity:activity:1.9.0")
    implementation("androidx.webkit:webkit:1.14.0")
}
