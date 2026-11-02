// Package gen holds the server stubs and types generated from api/openapi.yaml.
// Do not edit api.gen.go; change the OpenAPI file and run `make generate`.
package gen

//go:generate go tool oapi-codegen -config config.yaml ../../../api/openapi.yaml
