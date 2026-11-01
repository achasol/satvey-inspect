# Android verification stays entirely inside Docker; no host JDK/SDK required.
FROM node:22-alpine AS web
WORKDIR /work
COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci --no-audit --no-fund
COPY apps/web ./apps/web
COPY scripts/build-mobile.mjs ./scripts/build-mobile.mjs
ARG API_ORIGIN=https://inspect.invalid
ENV VITE_API_URL=${API_ORIGIN} MOBILE_VERIFY_ONLY=1
RUN node scripts/build-mobile.mjs

FROM eclipse-temurin:21-jdk-jammy@sha256:4b1a74fbffbe6b4e7b6f0171a472478282fb463790a51edf10e465d578f22b69 AS android
ENV ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    GRADLE_USER_HOME=/gradle-cache
RUN apt-get update && apt-get install --no-install-recommends -y curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# Archive and SHA-256 published on https://developer.android.com/studio.
RUN curl --fail --location --retry 3 -o /tmp/android-tools.zip \
      https://dl.google.com/android/repository/commandlinetools-linux-15859902_latest.zip \
    && printf '%s  %s\n' 4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583 /tmp/android-tools.zip | sha256sum -c - \
    && mkdir -p /opt/android-sdk/cmdline-tools \
    && unzip -q /tmp/android-tools.zip -d /opt/android-sdk/cmdline-tools \
    && mv /opt/android-sdk/cmdline-tools/cmdline-tools /opt/android-sdk/cmdline-tools/latest \
    && rm /tmp/android-tools.zip
RUN yes | /opt/android-sdk/cmdline-tools/latest/bin/sdkmanager --licenses >/dev/null \
    && /opt/android-sdk/cmdline-tools/latest/bin/sdkmanager 'platforms;android-36' 'build-tools;35.0.0' 'build-tools;36.0.0'
WORKDIR /work
COPY --from=web /work/node_modules ./node_modules
COPY --from=web /work/apps/web/android ./apps/web/android
WORKDIR /work/apps/web/android
RUN chmod +x gradlew
CMD ["./gradlew", "assembleDebug", "bundleRelease", "--no-daemon", "--max-workers=2", "-Dorg.gradle.jvmargs=-Xmx1024m"]
