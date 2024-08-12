pipeline {
    agent any

    stages {
        stage('Pull Code') {
            steps {
                checkout([$class: 'GitSCM', branches: [[name: 'main']], userRemoteConfigs: [[url: 'git@github.com:YevhenTrambai/test-step2.git', credentialsId: 'GIT_SSH_KEY']]])
            }
        }

        stage('Install Dependencies') {
            steps {
                sh 'npm install'
                
            }
        }

        stage('Build Docker Image') {
            steps {
                script {
                    docker.build('yevhent/test-step2/step_proj_container')
                }
            }
        }

        stage('Run Docker Container') {
            steps {
                script {
                    def app = docker.image('yevhent/test-step2/step_proj_container')
                    app.inside('--entrypoint="" -v /home/vagrant/opt/jenkins/workspace/Step2-test-pipeline:/app -w /app') {
                        sh 'npm test'
                    }
                }
            }
        }

        stage('Push to Docker Hub') {
            when {
                expression {
                    currentBuild.result == null || currentBuild.result == 'SUCCESS'
                }
            }
            steps {
                script {
                    docker.withRegistry('https://index.docker.io/v1/', 'dockerhub_cred') {
                        docker.image('yevhent/test-step2/step_proj_container').push('latest')
                    }
                }
            }
        }
    }

    post {
        success {
            echo 'Build and tests succeeded'
        }
        failure {
            echo 'Tests failed'
        }
    }
}

