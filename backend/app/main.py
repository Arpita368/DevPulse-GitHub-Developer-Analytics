from fastapi import FastAPI


app = FastAPI(
    title="DevPulse API",
    version="1.0.0"
)


@app.get("/")
def root():
    return {
        "message": "DevPulse API is running"
    }