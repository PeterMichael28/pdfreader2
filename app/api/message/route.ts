import { db } from '@/lib/db'
import { openai } from '@/lib/openai'
import { getPineconeClient } from '@/lib/pinecone'
import { SendMessageValidator } from '@/lib/validators/SendMessageValidator'
import { getKindeServerSession } from '@kinde-oss/kinde-auth-nextjs/server'
import { OpenAIEmbeddings } from 'langchain/embeddings/openai'
import { PineconeStore } from 'langchain/vectorstores/pinecone'
import { NextRequest } from 'next/server'

import { OpenAIStream, StreamingTextResponse } from 'ai'



export const POST = async (req: NextRequest) => {
  // endpoint for asking a question to a pdf file

  const body = await req.json()

  const { getUser } = getKindeServerSession()
  const user = await getUser()

  const userId = user?.id

  if (!userId)
    return new Response('Unauthorized', { status: 401 })

  const { fileId, message } =
    SendMessageValidator.parse(body)

  const file = await db.file.findFirst({
    where: {
      id: fileId,
      userId,
    },
  })

  if (!file)
    return new Response('Not found', { status: 404 })

  await db.message.create({
    data: {
      text: message,
      isUserMessage: true,
      userId,
      fileId,
    },
  })

  // 1: vectorize message
  const embeddings = new OpenAIEmbeddings({
    openAIApiKey: process.env.OPENAI_API_KEY,
  })

  const pinecone = await getPineconeClient()
  const pineconeIndex = pinecone.Index('pdfreader');
  // console.log('ok1');
  const vectorStore = await PineconeStore.fromExistingIndex(
   embeddings,
   {
    pineconeIndex,
    filter: { fileId },
   },
  );
  //console.log('ok2');

  const results = await vectorStore.similaritySearch(message, 4);
  //console.log('ok3');

  const prevMessages = await db.message.findMany({
   where: {
    fileId,
   },
   orderBy: {
    createdAt: 'asc',
   },
   take: 6,
  });
  //console.log('ok4');

  const formattedPrevMessages = prevMessages.map(
   (msg: { isUserMessage: any; text: any }) => ({
    role: msg.isUserMessage
     ? ('user' as const)
     : ('assistant' as const),
    content: msg.text,
   }),
  );
  //console.log('ok5');

  const response = await openai.chat.completions.create({
   model: 'gpt-3.5-turbo',
   temperature: 0,
   stream: true,
   messages: [
    {
     role: 'system',
     content:
      'Use the following pieces of context (or previous conversation if needed) to answer the users question in markdown format and be as friendly as possible so as to make user feel comfortable with you.',
    },
    {
     role: 'user',
     content: `Use the following pieces of context (or previous conversation if needed) to answer the users question in markdown format. \nIf you don't know the answer, just say that you don't know, don't try to make up an answer.
        
  \n----------------\n
  
  PREVIOUS CONVERSATION:
  ${formattedPrevMessages.map(
   (message: { role: string; content: any }) => {
    if (message.role === 'user') return `User: ${message.content}\n`;
    return `Assistant: ${message.content}\n`;
   },
  )}
  
  \n----------------\n
  
  CONTEXT:
  ${results.map((r) => r.pageContent).join('\n\n')}
  
  USER INPUT: ${message}`,
    },
   ],
  });

  const stream = OpenAIStream(response, {
   async onCompletion(completion) {
    await db.message.create({
     data: {
      text: completion,
      isUserMessage: false,
      fileId,
      userId,
     },
    });
   },
  });
  console.log('ok6');

  return new StreamingTextResponse(stream)
}