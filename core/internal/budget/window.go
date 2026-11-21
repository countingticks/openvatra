package budget

// Window is the model's context split into the parts the budget plans with. All numbers are tokens.
type Window struct {
	Context    int // the model's context size
	AnswerRoom int // min(Context/4, 4096)
	Room       int // Context - AnswerRoom
	Trigger    int // Room - min(Context*15/100, 8192)
	Target     int // Room / 2
	ToolCap    int // Context / 10
}

// maxBuffer caps the safety margin below Room, so a huge context doesn't waste a fifth of itself.
const maxBuffer = 8192

// NewWindow computes the window for a context size.
func NewWindow(contextSize int) Window {
	answer := AnswerRoom(contextSize)
	room := contextSize - answer
	return Window{
		Context:    contextSize,
		AnswerRoom: answer,
		Room:       room,
		Trigger:    room - min(contextSize*15/100, maxBuffer),
		Target:     room / 2,
		ToolCap:    contextSize / 10,
	}
}
