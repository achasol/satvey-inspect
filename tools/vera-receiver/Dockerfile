FROM golang:1.26-alpine AS build
RUN apk add --no-cache gcc musl-dev
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -p 1 -trimpath -o /vera-receiver .

FROM alpine:3.22
RUN adduser -D -u 10001 receiver
COPY --from=build /vera-receiver /vera-receiver
USER receiver
EXPOSE 8090
ENTRYPOINT ["/vera-receiver"]
