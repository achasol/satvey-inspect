FROM golang:1.26-alpine AS build
RUN apk add --no-cache ffmpeg
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -o /server .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates wget ffmpeg && adduser -D -u 10001 satvey
COPY --from=build /server /server
USER satvey
EXPOSE 8080
ENTRYPOINT ["/server"]
