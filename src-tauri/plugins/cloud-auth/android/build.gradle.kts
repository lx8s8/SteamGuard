import org.jetbrains.kotlin.gradle.dsl.JvmTarget
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}
android {
    namespace = "com.kasen.steamguard.cloudauth"
    compileSdk = 37
    defaultConfig { minSdk = 24 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
}
dependencies {
    implementation(project(":tauri-android"))
    implementation("com.google.android.gms:play-services-auth:22.0.0")
    implementation("androidx.activity:activity-ktx:1.12.0")
}
kotlin { compilerOptions { jvmTarget = JvmTarget.JVM_1_8 } }
