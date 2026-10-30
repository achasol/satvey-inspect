FROM golang:1.26-alpine AS build
RUN apk add --no-cache ffmpeg gcc musl-dev
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -p 1 -trimpath -o /server ./cmd/server

FROM alpine:3.22
RUN apk add --no-cache ca-certificates wget ffmpeg && adduser -D -u 10001 satvey
COPY --from=build /server /server
USER satvey
EXPOSE 8080
ENTRYPOINT ["/server"]
