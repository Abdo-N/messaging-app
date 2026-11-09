import express from 'express';

const app = express();
const port = process.env.PORT || 3000;


app.use(express.json());

app.use("/", (req, res) => {
    res.send("Hello from the server!");
    }
);

app.listen(port, () => {
	console.log(`Server listening on port ${port}`);
});
