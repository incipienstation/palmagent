// Experiment-only NDJSON over a private Unix socket, not a production transport.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"

	"example.invalid/palmagent-language-experiment/contract"
	"example.invalid/palmagent-language-experiment/model"
)

func handle(conn net.Conn) {
	defer conn.Close()
	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	writer := json.NewEncoder(conn)
	for scanner.Scan() {
		var input any
		response := map[string]any{"protocol": contract.Protocol}
		if json.Unmarshal(scanner.Bytes(), &input) != nil {
			response["error"] = "invalid_json"
		} else if catalog, err := model.Parse(input); err != nil {
			response["error"] = "empty_catalog"
		} else {
			response["catalog"] = catalog
		}
		if writer.Encode(response) != nil {
			return
		}
	}
}
func main() {
	listener, err := net.Listen("unix", os.Args[1])
	if err != nil {
		panic(err)
	}
	defer listener.Close()
	if err := os.Chmod(os.Args[1], 0600); err != nil {
		panic(err)
	}
	fmt.Println("ready")
	for {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		go handle(conn)
	}
}
